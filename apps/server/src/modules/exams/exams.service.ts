import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ExamPapersRepository } from '../../database/repositories/exam-papers.repo.js';
// 注意：repo 类必须是值导入（非 import type）——NestJS DI 依赖
// emitDecoratorMetadata 的设计时类型，type-only import 运行时被擦除会导致
// 构造参数元数据退化为 Object、注入解析失败（ExamsModule 启动报错）。
import { ExamSessionsRepository } from '../../database/repositories/exam-sessions.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { JudgeCoreService } from '../practice/judge-core.service.js';
import { parseOptions } from '../../common/utils/parse-options.util.js';
import type { ExamSessionRow, ExamAnswerRow } from '../../database/repositories/exam-sessions.repo.js';
import type { ExamPaperDto, PaperDetailDto, PaperQueryDto } from './dto/paper-query.dto.js';
import type {
  ExamResultsDto, ExamSummaryDto, SessionCreatedDto, SessionCreateDto,
  SessionQuestionDto, SessionStateDto, SubmitAnswerDto,
} from './dto/session-create.dto.js';

/** 会话时长合法区间（分钟）。 */
const MIN_DURATION = 10;
const MAX_DURATION = 300;

/**
 * 考试模块 service。
 *
 * Task 1：试卷列表 + 详情（白名单序列化，answer/explanation 一律剥离）。
 * Task 2：会话生命周期——创建/续考、单题提交（同步判题）、交卷（幂等）、
 * 超时自动收卷、结果查询。
 *
 * 判题复用 JudgeCoreService（source='exam', sourceRefId=sessionId）：
 * 答错入错题本 / 答对清零由 JudgeCore 内部处理；本 service 只对
 * 「未作答按错计」与「补判失败」两类直接写 mainErrorRepo。
 */
@Injectable()
export class ExamsService {
  constructor(
    private readonly examPapersRepo: ExamPapersRepository,
    private readonly examSessionsRepo: ExamSessionsRepository,
    private readonly judgeCore: JudgeCoreService,
    private readonly mainErrorRepo: MainErrorBooksRepository,
  ) {}

  /** 试卷列表：透传筛选参数给 repo，行 -> ExamPaperDto 映射。 */
  async listPapers(query: PaperQueryDto): Promise<ExamPaperDto[]> {
    const rows = await this.examPapersRepo.findPapers(query);
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      year: row.year,
      district: row.district,
      examType: row.exam_type,
      gradeBand: row.grade_band,
      questionCount: row.question_count,
    }));
  }

  /** 试卷详情：题目元数据 + 推荐时长；试卷不存在 -> 404。 */
  async getPaperDetail(id: number): Promise<PaperDetailDto> {
    const paper = await this.examPapersRepo.findById(id);
    if (!paper) {
      throw new NotFoundException(`试卷不存在：${id}`);
    }
    const questions = await this.examPapersRepo.findQuestionsByPaperId(id);
    return {
      id: paper.id,
      title: paper.title,
      durationMinutes: computeRecommendedDuration(questions),
      questions: questions.map((q) => this.toSessionQuestion(q)),
    };
  }

  // ============================================================
  // Task 2：会话生命周期
  // ============================================================

  /** 开考/续考：同卷已有 in_progress 会话直接返回（不重置时长），否则新建。 */
  async createSession(studentId: number, dto: SessionCreateDto): Promise<SessionCreatedDto> {
    const duration = dto.durationMinutes;
    if (!Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION) {
      throw new BadRequestException(`durationMinutes 仅允许 ${MIN_DURATION}-${MAX_DURATION} 的整数`);
    }
    const paper = await this.examPapersRepo.findById(dto.paperId);
    if (!paper) {
      throw new NotFoundException(`试卷不存在：${dto.paperId}`);
    }

    const existing = await this.examSessionsRepo.findInProgressByStudentPaper(studentId, dto.paperId);

    if (existing) {
      // 续考：返回既有会话（deadline 不变）
      return {
        sessionId: existing.id,
        deadlineAt: existing.deadline_at,
        remainingSeconds: this.remainingSeconds(existing),
        questions: await this.loadQuestions(existing.paper_id),
      };
    }

    const deadlineAt = new Date(Date.now() + duration * 60000);
    const sessionId = await this.examSessionsRepo.create({
      studentId,
      paperId: dto.paperId,
      subjectId: paper.subject_id!,
      durationMinutes: duration,
      deadlineAt,
    });
    return {
      sessionId,
      deadlineAt,
      remainingSeconds: this.remainingSeconds({ deadline_at: deadlineAt }),
      questions: await this.loadQuestions(dto.paperId),
    };
  }

  /** 会话状态（进行中）：题单 + 已答 map（只有 answerText，不泄露对错）+ 剩余秒数。超时自动收卷。 */
  async getSession(studentId: number, sessionId: number): Promise<SessionStateDto> {
    const session = await this.loadOwnedSession(studentId, sessionId);
    const questions = await this.loadQuestions(session.paper_id);

    if (session.status === 'submitted') {
      const answers = await this.examSessionsRepo.findAnswersBySession(sessionId);
      return { sessionId, status: 'submitted', remainingSeconds: 0, questions, answered: this.toAnsweredMap(answers) };
    }

    if (this.isExpired(session)) {
      // 发现超时 -> 服务端自动收卷（与手动交卷同一 finalize 逻辑）
      await this.finalizeSession(session);
      const answers = await this.examSessionsRepo.findAnswersBySession(sessionId);
      return { sessionId, status: 'submitted', remainingSeconds: 0, questions, answered: this.toAnsweredMap(answers) };
    }

    const answers = await this.examSessionsRepo.findAnswersBySession(sessionId);
    return {
      sessionId,
      status: 'in_progress',
      remainingSeconds: this.remainingSeconds(session),
      questions,
      answered: this.toAnsweredMap(answers),
    };
  }

  /**
   * 单题提交（同步判题）：await judgeCore（exact 即返，AI 最长 judgment 90s per-scene）
   * -> upsertAnswer 落完整判题结果 -> 白名单响应 {saved:true}（对错只在 results 出现）。
   * 判题抛错时先落 answerText（is_correct NULL 在途），错误透传，交卷时统一补判。
   */
  async submitAnswer(studentId: number, sessionId: number, dto: SubmitAnswerDto): Promise<{ saved: true }> {
    const session = await this.loadOwnedSession(studentId, sessionId);

    if (session.status === 'submitted') {
      throw new HttpException({ code: 4101, message: '考试已交卷，不能再作答' }, 409);
    }

    const questions = await this.examPapersRepo.findQuestionsByPaperId(session.paper_id);
    const q = questions.find((x) => x.questionId === dto.questionId);
    if (!q) {
      throw new BadRequestException('题目不在该试卷题单中');
    }

    if (this.isExpired(session)) {
      // 超 deadline -> 先自动收卷再 409（未作答按错计一并落库）
      await this.finalizeSession(session);
      throw new HttpException({ code: 4102, message: '考试时间已到，已自动收卷' }, 409);
    }

    try {
      const out = await this.judgeCore.judgeQuestion({
        studentId,
        subjectId: session.subject_id,
        questionId: dto.questionId,
        studentAnswer: dto.answerText,
        source: 'exam',
        sourceRefId: sessionId,
      });
      await this.examSessionsRepo.upsertAnswer({
        sessionId,
        questionId: dto.questionId,
        questionOrder: q.questionNo,
        answerText: dto.answerText,
        isCorrect: out.isCorrect ? 1 : 0,
        method: out.method,
        analysis: out.analysis,
        errorType: out.errorType ?? null,
        judgedAt: new Date(),
      });
    } catch (err) {
      // 判题失败：保留作答文本（在途，is_correct NULL），交卷时补判；错误透传给前端重试
      await this.examSessionsRepo.upsertAnswer({
        sessionId,
        questionId: dto.questionId,
        questionOrder: q.questionNo,
        answerText: dto.answerText,
      });
      throw err;
    }
    return { saved: true };
  }

  /** 交卷（幂等：已 submitted 直接重算汇总返回）。 */
  async submit(studentId: number, sessionId: number): Promise<ExamSummaryDto> {
    const session = await this.loadOwnedSession(studentId, sessionId);
    if (session.status === 'submitted') {
      const questions = await this.examPapersRepo.findQuestionsByPaperId(session.paper_id);
      const answers = await this.examSessionsRepo.findAnswersBySession(sessionId);
      return this.summarize(questions.length, answers);
    }
    return this.finalizeSession(session);
  }

  /** 结果页：仅 submitted 可查（in_progress 409）；items JOIN questions 带 explanation。 */
  async getResults(studentId: number, sessionId: number): Promise<ExamResultsDto> {
    const session = await this.loadOwnedSession(studentId, sessionId);
    if (session.status !== 'submitted') {
      throw new HttpException({ code: 4103, message: '考试尚未交卷，暂无成绩' }, 409);
    }
    const rows = await this.examSessionsRepo.findAnswersWithQuestions(sessionId);
    const items = rows.map((row) => ({
      questionId: row.question_id,
      questionNo: row.question_order,
      text: row.text,
      type: row.type,
      options: parseOptions(row.options),
      answerText: row.answer_text,
      isCorrect: row.is_correct ?? 0,
      analysis: row.analysis,
      explanation: row.explanation,
    }));
    const summary = this.summarize(items.length, items.map((i) => ({ is_correct: i.isCorrect }) as ExamAnswerRow));
    return { ...summary, items };
  }

  // ============================================================
  // 内部
  // ============================================================

  /** 加载会话并做归属校验（防 IDOR）：不存在 404，非本人 403。 */
  private async loadOwnedSession(studentId: number, sessionId: number): Promise<ExamSessionRow> {
    const session = await this.examSessionsRepo.findById(sessionId);
    if (!session) {
      throw new NotFoundException(`考试会话不存在：${sessionId}`);
    }
    if (session.student_id !== studentId) {
      throw new ForbiddenException('无权访问该考试会话');
    }
    return session;
  }

  /** 收卷核心（手动交卷与超时自动收卷共用）：
   *  未作答题直接判错入错题本（不走 judgeCore，无答案可判）；
   *  在途题（answer_text 非空、is_correct NULL）judgeCore 补判，失败按错计 method='failed' 仍入错题本；
   *  最后 markSubmitted 并汇总。 */
  private async finalizeSession(session: ExamSessionRow): Promise<ExamSummaryDto> {
    const questions = await this.examPapersRepo.findQuestionsByPaperId(session.paper_id);
    const answers = await this.examSessionsRepo.findAnswersBySession(session.id);
    const byQuestion = new Map(answers.map((a) => [a.question_id, a]));

    for (const q of questions) {
      const a = byQuestion.get(q.questionId);
      if (!a || (a.answer_text == null && a.is_correct == null)) {
        // 未作答：按错计 + 入错题本（直接 mainErrorRepo.create，JudgeCore 不处理未作答场景）
        await this.examSessionsRepo.upsertAnswer({
          sessionId: session.id,
          questionId: q.questionId,
          questionOrder: q.questionNo,
          answerText: a?.answer_text ?? null,
          isCorrect: 0,
          method: 'unanswered',
          judgedAt: new Date(),
        });
        await this.writeExamErrorBook(session, q.questionId);
      } else if (a.is_correct == null) {
        // 在途：judgeCore 补判；失败按错计 method='failed' 仍入错题本
        try {
          const out = await this.judgeCore.judgeQuestion({
            studentId: session.student_id,
            subjectId: session.subject_id,
            questionId: q.questionId,
            studentAnswer: a.answer_text!,
            source: 'exam',
            sourceRefId: session.id,
          });
          await this.examSessionsRepo.upsertAnswer({
            sessionId: session.id,
            questionId: q.questionId,
            questionOrder: q.questionNo,
            answerText: a.answer_text,
            isCorrect: out.isCorrect ? 1 : 0,
            method: out.method,
            analysis: out.analysis,
            errorType: out.errorType ?? null,
            judgedAt: new Date(),
          });
        } catch {
          await this.examSessionsRepo.upsertAnswer({
            sessionId: session.id,
            questionId: q.questionId,
            questionOrder: q.questionNo,
            answerText: a.answer_text,
            isCorrect: 0,
            method: 'failed',
            judgedAt: new Date(),
          });
          await this.writeExamErrorBook(session, q.questionId);
        }
      }
      // else：已判题（含单题提交时落库的结果），跳过
    }

    await this.examSessionsRepo.markSubmitted(session.id);
    const finalAnswers = await this.examSessionsRepo.findAnswersBySession(session.id);
    return this.summarize(questions.length, finalAnswers);
  }

  /** 考试来源错题本写入（未作答按错计 / 补判失败兜底共用）。 */
  private async writeExamErrorBook(session: ExamSessionRow, questionId: number): Promise<void> {
    await this.mainErrorRepo.create({
      student_id: session.student_id,
      subject_id: session.subject_id,
      question_id: questionId,
      source: 'exam',
      source_ref_id: session.id,
      question_n: null,
      lesson_id: null,
      wrong_answer_text: null,
    });
  }

  /** 汇总：correctCount（is_correct=1 计数）/ totalCount（题单长度）/ accuracy（百分比一位小数）。 */
  private summarize(totalCount: number, answers: Array<Pick<ExamAnswerRow, 'is_correct'>>): ExamSummaryDto {
    const correctCount = answers.filter((a) => a.is_correct === 1).length;
    const accuracy = totalCount > 0 ? Math.round((correctCount / totalCount) * 1000) / 10 : 0;
    return { correctCount, totalCount, accuracy };
  }

  /** 剩余秒数（deadline - now；超时为 0 或负值，由调用方决定收卷语义）。 */
  private remainingSeconds(session: Pick<ExamSessionRow, 'deadline_at'>): number {
    return Math.floor((session.deadline_at.getTime() - Date.now()) / 1000);
  }

  private isExpired(session: Pick<ExamSessionRow, 'deadline_at'>): boolean {
    return session.deadline_at.getTime() <= Date.now();
  }

  /** 题单加载 + 白名单映射（同 getPaperDetail，不含 answer/explanation）。 */
  private async loadQuestions(paperId: number): Promise<SessionQuestionDto[]> {
    const questions = await this.examPapersRepo.findQuestionsByPaperId(paperId);
    return questions.map((q) => this.toSessionQuestion(q));
  }

  private toSessionQuestion(q: { questionId: number; questionNo: number; text: string; type: string; options: string | null }): SessionQuestionDto {
    return {
      questionId: q.questionId,
      questionNo: q.questionNo,
      text: q.text,
      type: q.type,
      options: parseOptions(q.options),
    };
  }

  /** 已答 map：questionId -> {answerText}（只有作答文本，判题字段一律剥离）。 */
  private toAnsweredMap(answers: ExamAnswerRow[]): Record<number, { answerText: string | null }> {
    const map: Record<number, { answerText: string | null }> = {};
    for (const a of answers) {
      map[a.question_id] = { answerText: a.answer_text };
    }
    return map;
  }
}

/**
 * 推荐时长（纯函数，导出供测试/复用）：
 * choice/true_false 每题 1 分钟，其余（proof/short_answer/fill_blank...）每题 3 分钟；
 * 总和向上取整到 15 的倍数，clamp 到 [30, 180]。
 */
export function computeRecommendedDuration(questions: Array<{ type: string }>): number {
  let sum = 0;
  for (const q of questions) {
    sum += q.type === 'choice' || q.type === 'true_false' ? 1 : 3;
  }
  const rounded = Math.ceil(sum / 15) * 15;
  return Math.min(180, Math.max(30, rounded));
}
