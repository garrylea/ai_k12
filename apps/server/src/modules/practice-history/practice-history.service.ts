import { Injectable, BadRequestException } from '@nestjs/common';
import { ExamSessionsRepository } from '../../database/repositories/exam-sessions.repo.js';
import { SpecialPracticeSessionsRepository } from '../../database/repositories/special-practice-sessions.repo.js';
import { SpecialAnswerRecordsRepository } from '../../database/repositories/special-answer-records.repo.js';
import { ChinesePassagesRepository, toSentences } from '../../database/repositories/chinese-passages.repo.js';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import type { HistoryRunQuestion, SimilarPracticeResult } from '../training/history-practice.service.js';
import { HistoryPracticeService } from '../training/history-practice.service.js';
import type {
  PracticeHistoryQueryDto,
  PracticeHistoryItem,
  PracticeHistoryDetail,
  PracticeHistoryListResult,
  PracticeHistoryQuestion,
} from './practice-history.dto.js';

/**
 * 练习记录查询（Task 4，2026-11-01）。
 *
 * 列表把考试与专项练习合成一个视角（spec §4.2）。**只读**，不改任何学生状态。
 * 归属校验一律按 JWT 的 studentId 过滤（防 IDOR）。
 * 2026-11-06 增加 `redo`（单题重做）：同样只读——回放原题，不建会话、不写作答、不发分。
 */
@Injectable()
export class PracticeHistoryService {
  constructor(
    private readonly examSessionsRepo: ExamSessionsRepository,
    private readonly specialSessionsRepo: SpecialPracticeSessionsRepository,
    private readonly specialAnswersRepo: SpecialAnswerRecordsRepository,
    private readonly passagesRepo: ChinesePassagesRepository,
    private readonly questionsRepo: QuestionsRepository,
    private readonly historyPractice: HistoryPracticeService,
  ) {}

  async list(query: PracticeHistoryQueryDto & { studentId: number }): Promise<PracticeHistoryListResult> {
    const page = Math.max(1, Math.floor(query.page ?? 1) || 1);
    const pageSize = Math.min(50, Math.max(1, Math.floor(query.pageSize ?? 20) || 20));
    const offset = (page - 1) * pageSize;
    // 跨两张表分页：两端各取 offset+pageSize 条，合并排序后再 slice，保证第 N 页不丢不重。
    const fetchLimit = offset + pageSize;

    const [exams, specials] = await Promise.all([
      this.examSessionsRepo.listSubmittedByStudent({
        studentId: query.studentId, subjectId: query.subjectId,
        limit: fetchLimit, offset: 0,
      }),
      this.specialSessionsRepo.listByStudent(query.studentId, {
        subjectId: query.subjectId, limit: fetchLimit, offset: 0,
      }),
    ]);

    const examItems = await Promise.all(exams.map(async (e): Promise<PracticeHistoryItem> => {
      const c = await this.examSessionsRepo.countAnswersBySession(e.id);
      return {
        source: 'exam',
        sessionId: e.id,
        subjectId: e.subject_id,
        title: e.title,
        module: null,
        startedAt: e.started_at,
        completedAt: e.submitted_at,
        totalCount: c.total,
        correctCount: c.correct,
      };
    }));
    const specialItems = await Promise.all(specials.map(async (s): Promise<PracticeHistoryItem> => {
      const c = await this.specialAnswersRepo.countBySession(s.id);
      return {
        source: 'special',
        sessionId: s.id,
        subjectId: s.subject_id,
        title: s.title,
        module: s.module,
        startedAt: s.started_at,
        completedAt: s.completed_at,
        totalCount: c.total,
        correctCount: c.correct,
      };
    }));

    const items = [...examItems, ...specialItems]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(offset, offset + pageSize);

    const [examTotal, specialTotal] = await Promise.all([
      this.examSessionsRepo.countSubmittedByStudent(query.studentId, query.subjectId),
      this.specialSessionsRepo.countByStudent(query.studentId, query.subjectId),
    ]);

    return { items, total: examTotal + specialTotal, page, pageSize };
  }

  async getDetail(input: {
    studentId: number; source: 'exam' | 'special'; sessionId: number;
  }): Promise<PracticeHistoryDetail | null> {
    if (input.source !== 'exam' && input.source !== 'special') {
      throw new BadRequestException({ code: 400, message: 'source 仅允许 exam | special' });
    }
    if (!Number.isInteger(input.sessionId) || input.sessionId < 1) {
      throw new BadRequestException({ code: 400, message: 'sessionId 须为正整数' });
    }

    if (input.source === 'exam') {
      const session = await this.examSessionsRepo.findByIdOwned(input.sessionId, input.studentId);
      if (!session) return null;
      const [answers, count] = await Promise.all([
        this.examSessionsRepo.findAnswersWithQuestions(input.sessionId),
        this.examSessionsRepo.countAnswersBySession(input.sessionId),
      ]);
      const kpMap = await this.questionsRepo.findKpIdsByQuestionIds(
        answers.map((a) => a.question_id).filter((id): id is number => id != null),
      );
      return {
        session: {
          source: 'exam', sessionId: session.id, subjectId: session.subject_id,
          title: session.title, module: null, startedAt: session.started_at,
          completedAt: session.submitted_at, totalCount: count.total, correctCount: count.correct,
        },
        questions: answers.map((a): PracticeHistoryQuestion => {
          const canRedo = a.question_id != null && a.is_active === 1;
          const hasKp = a.question_id != null && kpMap.has(a.question_id);
          const canSimilar = canRedo
            && (session.subject_id === 1 || session.subject_id === 4)
            && !!a.answer
            && hasKp;
          return {
            questionId: a.question_id,
            questionOrder: a.question_order,
            answerText: a.answer_text,
            isCorrect: a.is_correct === null ? null : a.is_correct === 1,
            score: a.score !== null ? Number(a.score) : null,
            method: a.method,
            analysis: a.analysis,
            judgedAt: a.judged_at,
            questionContent: a.text,
            materialText: a.material_text,
            questionAnswer: a.answer,
            questionAnalysis: a.explanation,
            refType: 'question',
            refId: null,
            sentenceIndex: null,
            passageTitle: null,
            passageSentence: null,
            canRedo,
            canSimilar,
          };
        }),
      };
    }

    const session = await this.specialSessionsRepo.findByIdOwned(input.sessionId, input.studentId);
    if (!session) return null;
    const [answers, count] = await Promise.all([
      this.specialAnswersRepo.listBySession(input.sessionId),
      this.specialAnswersRepo.countBySession(input.sessionId),
    ]);
    const kpMap = await this.questionsRepo.findKpIdsByQuestionIds(
      answers.map((a) => a.question_id).filter((id): id is number => id != null),
    );

    // 语文三专项的「题」是 passage+sentence：按需批量回放篇名与句原文（同篇只查一次）。
    const passageCache = new Map<number, { title: string; sentences: string[] }>();
    const loadPassage = async (id: number) => {
      if (passageCache.has(id)) return passageCache.get(id)!;
      const row = await this.passagesRepo.findById(id);
      const entry = row
        ? { title: row.work_title, sentences: toSentences(row.sentences).map((s) => s.text) }
        : { title: '', sentences: [] };
      passageCache.set(id, entry);
      return entry;
    };

    const questions = await Promise.all(answers.map(async (a): Promise<PracticeHistoryQuestion> => {
      let passageTitle: string | null = null;
      let passageSentence: string | null = null;
      if (a.ref_type === 'passage' && a.ref_id !== null) {
        const p = await loadPassage(a.ref_id);
        passageTitle = p.title || null;
        passageSentence = a.sentence_index !== null ? (p.sentences[a.sentence_index] ?? null) : null;
      }
      const canRedo = a.question_id != null && a.question_is_active === 1;
      const hasKp = a.question_id != null && kpMap.has(a.question_id);
      const canSimilar = canRedo
        && (session.subject_id === 1 || session.subject_id === 4)
        && !!a.question_answer
        && hasKp;
      return {
        questionId: a.question_id,
        questionOrder: a.question_order,
        answerText: a.answer_text,
        isCorrect: a.is_correct === null ? null : a.is_correct === 1,
        score: a.score !== null ? Number(a.score) : null,
        method: a.method,
        analysis: a.analysis,
        judgedAt: a.judged_at,
        questionContent: a.question_content,
        // 专项侧没有 material（语文专项的"材料"是篇名+句原文，走 passageTitle/passageSentence）
        materialText: null,
        questionAnswer: a.question_answer,
        questionAnalysis: a.question_analysis,
        refType: a.ref_type,
        refId: a.ref_id,
        sentenceIndex: a.sentence_index,
        passageTitle,
        passageSentence,
        canRedo,
        canSimilar,
      };
    }));

    return {
      session: {
        source: 'special', sessionId: session.id, subjectId: session.subject_id,
        title: session.title, module: session.module, startedAt: session.started_at,
        completedAt: session.completed_at, totalCount: count.total, correctCount: count.correct,
      },
      questions,
    };
  }

  /**
   * 单题重做（2026-11-06）。
   *
   * 归属双校验：先 `findByIdOwned`（会话必须是本人的），再确认该 questionId 确实出现在
   * 这个会话的作答行里——只凭 sessionId 换 questionId 就能重做别人的题（IDOR）。
   * 任一步不通过 → null（controller 转 404，不泄露存在性）。
   * **不建会话、不写作答、不发分**。
   */
  async redo(input: {
    studentId: number; source: 'exam' | 'special'; sessionId: number; questionId: number;
  }): Promise<{ questions: HistoryRunQuestion[]; title: string } | null> {
    const found = await this.loadSessionQuestion(input);
    if (!found) return null;
    const question = await this.historyPractice.loadRedoQuestion(input.questionId);
    // 题目下架 / 被删：会话里有作答行但题已不可练，属可重试的无效请求
    if (!question) throw new BadRequestException({ code: 400, message: '题目已下架' });
    return {
      questions: [question],
      title: `重做：${found.title ?? '练习'} · 第 ${found.order} 题`,
    };
  }

  /**
   * 同类型练习（2026-11-06）。
   *
   * 归属校验与 redo 同源（`loadSessionQuestion`）：会话必须属于本人，且 questionId 必须在
   * 这个会话的作答行里，否则 null（controller 转 404，不泄露存在性）。
   * 通过后把会话学科交给 `HistoryPracticeService` 抽题 + 建训练会话。
   */
  async similar(input: {
    studentId: number; source: 'exam' | 'special'; sessionId: number; questionId: number; count: number;
  }): Promise<SimilarPracticeResult | null> {
    const found = await this.loadSessionQuestion(input);
    if (!found) return null;
    return this.historyPractice.startSimilar({
      studentId: input.studentId,
      subjectId: found.subjectId,
      questionId: input.questionId,
      count: input.count,
    });
  }

  private async loadSessionQuestion(input: {
    studentId: number; source: 'exam' | 'special'; sessionId: number; questionId: number;
  }): Promise<{ subjectId: number; title: string | null; order: number } | null> {
    if (input.source === 'exam') {
      const session = await this.examSessionsRepo.findByIdOwned(input.sessionId, input.studentId);
      if (!session) return null;
      const answers = await this.examSessionsRepo.findAnswersBySession(input.sessionId);
      const row = answers.find((a) => a.question_id === input.questionId);
      if (!row) return null;
      return { subjectId: session.subject_id, title: session.title, order: row.question_order };
    }
    const session = await this.specialSessionsRepo.findByIdOwned(input.sessionId, input.studentId);
    if (!session) return null;
    const rows = await this.specialAnswersRepo.listBySession(input.sessionId);
    const row = rows.find((a) => a.question_id === input.questionId);
    if (!row) return null;
    return { subjectId: session.subject_id, title: session.title, order: row.question_order };
  }
}
