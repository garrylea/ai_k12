import { Injectable, Logger, HttpException, NotFoundException } from '@nestjs/common';
import { JudgeCoreService } from '../practice/judge-core.service.js';
import { ExplanationCacheService } from '../practice/explanation-cache.service.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { QuestionHintsRepository } from '../../database/repositories/question-hints.repo.js';
import { StudentHiddenQuestionsRepository } from '../../database/repositories/student-hidden-questions.repo.js';
import { AdminNotificationsRepository } from '../../database/repositories/admin-notifications.repo.js';
import { HintCapability } from '../../ai-core/capabilities/hint.capability.js';
import { ChinesePassagesRepository, buildDictationPrompt } from '../../database/repositories/chinese-passages.repo.js';
import { DictationFeedbackCapability } from '../../ai-core/capabilities/dictation-feedback.capability.js';
import { parseOptions } from '../../common/utils/parse-options.util.js';
import { evaluateDictation, type DictationDiffOp } from '../../common/utils/normalize-chinese.util.js';
import type { ErrorBookEntryDto, ErrorBookQueryDto } from './dto/error-book-query.dto.js';
import type {
  DictationPassageListItem,
  DictationQuestionItem,
  DictationJudgeResult,
} from './dto/dictation.dto.js';

/** 把 diff 渲染成一行可读文本，作为 LLM 错因输入：床前明月[光→先][漏:疑][多:啊]。 */
export function renderBodyDiff(ops: DictationDiffOp[]): string {
  return ops
    .map((op) => {
      if (op.type === 'equal') return op.text;
      if (op.type === 'wrong') return `[${op.expected}→${op.actual}]`;
      if (op.type === 'missing') return `[漏:${op.text}]`;
      return `[多:${op.text}]`;
    })
    .join('');
}

/**
 * 错题训练模块 service。
 *
 * 错题练习筛选列表（Task 1）+ 判题/仍错 bump（Task 2）+ 提示缓存（Task 3）
 * + 专项练习 KP 树 / 随机抽题（Task 8）。
 */
@Injectable()
export class TrainingService {
  private readonly logger = new Logger(TrainingService.name);

  constructor(
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly judgeCore: JudgeCoreService,
    private readonly questionsRepo: QuestionsRepository,
    private readonly knowledgePointsRepo: KnowledgePointsRepository,
    private readonly questionHintsRepo: QuestionHintsRepository,
    private readonly hint: HintCapability,
    private readonly hiddenRepo: StudentHiddenQuestionsRepository,
    private readonly explanationCache: ExplanationCacheService,
    private readonly notificationsRepo: AdminNotificationsRepository,
    private readonly dictationRepo: ChinesePassagesRepository,
    private readonly dictationFeedback: DictationFeedbackCapability,
  ) {}

  /** 错题练习筛选列表：调 repo 后按 errorBookId 聚合 kpIds，映射 DTO。 */
  async getErrorBookEntries(
    studentId: number,
    subjectId: number,
    filters: ErrorBookQueryDto,
  ): Promise<ErrorBookEntryDto[]> {
    const rows = await this.mainErrorRepo.findErrorBookEntries(studentId, subjectId, filters);
    // 同一错题多 KP 时 repo 返回多行（仅 kp_id 不同），按 id 聚合。
    const byId = new Map<number, ErrorBookEntryDto>();
    for (const row of rows) {
      const existing = byId.get(row.id);
      if (existing) {
        if (row.kp_id != null) existing.kpIds.push(row.kp_id);
        continue;
      }
      byId.set(row.id, {
        errorBookId: row.id,
        questionId: row.question_id,
        questionText: row.questionText ?? '',
        type: row.type,
        level: row.level,
        createdAt: new Date(row.created_at).toISOString(),
        kpIds: row.kp_id != null ? [row.kp_id] : [],
        options: parseOptions(row.options),
      });
    }
    return [...byId.values()];
  }

  /** 训练判题：JudgeCore 题中心变体的薄封装（source 由端点语义决定，不透传客户端任意值）。 */
  async judgeTraining(input: { studentId: number; questionId: number; subjectId: number; studentAnswer: string; source: 'targeted' | 'error_practice' }) {
    return this.judgeCore.judgeQuestion({ ...input, sourceRefId: null });
  }

  /** 语文默写：配置页篇目清单（抽题池 = verified=1 且 memorize_required=1 且 is_active=1）。
   *  只出篇名 + 册次——作者/朝代/正文都是判题答案字段，一律不下发。 */
  async listDictationPassages(): Promise<{ passages: DictationPassageListItem[] }> {
    const rows = await this.dictationRepo.findVerifiedForDictation();
    return {
      passages: rows.map((r) => ({
        passageId: r.id,
        workTitle: r.work_title,
        semester: r.semester,
      })),
    };
  }

  /**
   * 语文默写开练：指定篇目则按篇目出题（忽略册次），否则按册次（null=全部）随机抽。
   * 题项做白名单序列化——只出 passageId/prompt/workTitle/semester，作者/朝代/正文
   * 一律剥离（防答案泄露，与 startTargetedPractice 同规矩）。
   * 题面由篇名生成（`buildDictationPrompt`），**不再从 questions.content 取**。
   */
  async startDictation(input: {
    semester: string | null;
    passageIds: number[] | null;
    count: number;
  }): Promise<{ questions: DictationQuestionItem[] }> {
    const rows = input.passageIds && input.passageIds.length > 0
      ? await this.dictationRepo.findVerifiedByIds(input.passageIds)
      : await this.dictationRepo.findRandomVerified(input.semester, input.count);
    return {
      questions: rows.slice(0, input.count).map((r) => ({
        passageId: r.id,
        prompt: buildDictationPrompt(r.work_title),
        workTitle: r.work_title,
        semester: r.semester,
      })),
    };
  }

  /**
   * 语文默写判题：**纯程序**判对错（JudgeCore.judgeDictation），不等 LLM，
   * 且**不写任何学生状态**（独立化后不入错题本、不清零）。
   *
   * 2026-09-14 起错因文案与判题解耦：本方法只回判题结果（~25ms），
   * 答错时带 `feedbackPending=true`，由前端另调 generateDictationFeedback 取文案。
   * 解耦前错因 LLM 调用在关键路径上——本地 Qwen3.8-27B 是思考模型，
   * 一次错答要等 13–16 秒才看到对错，学生以为卡死。
   */
  async judgeDictation(input: {
    passageId: number;
    author: string;
    dynasty: string;
    body: string;
  }): Promise<DictationJudgeResult> {
    const passage = await this.dictationRepo.findById(input.passageId);
    if (!passage) {
      throw new NotFoundException(`默写篇目不存在：${input.passageId}`);
    }

    const expected = { author: passage.author, dynasty: passage.dynasty, body: passage.body };
    const judged = await this.judgeCore.judgeDictation({
      expected,
      student: { author: input.author, dynasty: input.dynasty, body: input.body },
    });

    // 显式构造返回，不用 spread：judged 带 method 字段，spread 进对象字面量会触发
    // TS 多余属性检查（DictationJudgeResult 未声明 method）。
    return {
      passageId: passage.id,
      isCorrect: judged.isCorrect,
      fields: judged.fields,
      bodyDiff: judged.bodyDiff,
      reference: expected,
      feedback: null,
      feedbackPending: !judged.isCorrect,
    };
  }

  /**
   * 语文默写错因文案（LLM，可选；判题后异步补取）。
   *
   * 只生成话术，**不碰判题**——独立化后判题不写任何学生状态，本方法同样只读篇目、只算差异。
   * 模型不可达/超时/两个模型都失败一律回 `feedback=null`，由前端显示兜底文案。
   */
  async generateDictationFeedback(input: {
    passageId: number;
    author: string;
    dynasty: string;
    body: string;
  }): Promise<{ feedback: string | null }> {
    const passage = await this.dictationRepo.findById(input.passageId);
    if (!passage) {
      throw new NotFoundException(`默写篇目不存在：${input.passageId}`);
    }

    const expected = { author: passage.author, dynasty: passage.dynasty, body: passage.body };
    const student = { author: input.author, dynasty: input.dynasty, body: input.body };
    const { fields, bodyDiff } = evaluateDictation(expected, student);

    try {
      const result = await this.dictationFeedback.generate({
        workTitle: passage.work_title,
        expected,
        student,
        fieldMatch: {
          author: fields.author.match,
          dynasty: fields.dynasty.match,
          body: fields.body.match,
        },
        bodyDiffText: renderBodyDiff(bodyDiff),
      });
      return { feedback: result.content || null };
    } catch (err) {
      this.logger.warn(`dictationFeedback.generate failed (passageId=${input.passageId}): ${err}`);
      return { feedback: null };
    }
  }

  /** 主观题自评：校验题目存在后委托 JudgeCore.recordSelfAssessment（留痕 + 错题本写入/清零）。
   *  自评 incorrect 与其他判错路径对齐：触发解析缓存兜底生成（题缺解析时）。 */
  async selfAssess(input: {
    studentId: number; questionId: number; subjectId: number;
    assessment: 'correct' | 'incorrect';
    source: 'targeted' | 'error_practice' | 'exam';
    sourceRefId?: number | null;
  }) {
    const q = await this.questionsRepo.findById(input.questionId);
    if (!q) {
      throw new NotFoundException(`题目不存在：${input.questionId}`);
    }
    const result = await this.judgeCore.recordSelfAssessment({ ...input, sourceRefId: input.sourceRefId ?? null });
    if (input.assessment === 'incorrect') {
      this.explanationCache.ensureExplanation(q);
    }
    return result;
  }

  /** 仍错 bump：错题重做仍答错时提升 level（镜像 PracticeService.bumpErrorLevels）。studentId 为归属校验（防 IDOR）。 */
  async bumpErrorLevels(errorBookIds: number[], studentId?: number): Promise<void> {
    await this.mainErrorRepo.bumpLevels(errorBookIds, studentId);
  }

  /**
   * 训练「提示」：题级缓存三段式（镜像 PracticeService.getHint 语义）：
   * 查 question_hints 缓存（命中直返，省 AI）→ 未命中调 HintCapability 生成
   * 苏格拉底式提示 → 写回缓存（best-effort，失败不阻断返回）。
   * 缓存是题级共享（不分学生）；题目不存在 -> 404；AI 失败 -> 503（code 5001）。
   */
  async getHint(input: { questionId: number }): Promise<{ hint: string; cached: boolean }> {
    // 0. 拿题面（训练题必来自题库，无题 404）
    const q = await this.questionsRepo.findById(input.questionId);
    if (!q) {
      throw new NotFoundException(`题目不存在：${input.questionId}`);
    }

    // 1. 查缓存
    const cachedRow = await this.questionHintsRepo.findByQuestionId(input.questionId);
    if (cachedRow) {
      return { hint: cachedRow.hint, cached: true };
    }

    // 2. 未命中 -> AI 生成
    try {
      const result = await this.hint.generate({
        questionContent: q.content,
        subject: 'math',
      });
      // 3. 写回缓存（失败不阻断返回，仅记日志）
      try {
        await this.questionHintsRepo.upsert(input.questionId, result.content);
      } catch (err) {
        this.logger.error(`questionHintsRepo.upsert failed (questionId=${input.questionId}): ${err}`);
      }
      return { hint: result.content, cached: false };
    } catch (err) {
      this.logger.error(`hint.generate failed: ${err}`);
      throw new HttpException(
        { code: 5001, message: '提示生成失败，请重试' },
        503,
      );
    }
  }

  /** 专项练习 KP 树：平铺列表透传（树形组装放前端）。 */
  async getKnowledgePoints(
    subjectId: number,
  ): Promise<Array<{ id: number; name: string; parentKpId: number | null; gradeBand: string }>> {
    return this.knowledgePointsRepo.findBySubject(subjectId);
  }

  /**
   * 专项练习开练：按学科 + 知识点（可选题型）随机抽题，排除该生已标记「不再展示」的题。
   * 题单做白名单序列化——只出 questionId/text/type/options，answer/explanation
   * 等字段一律剥离（防答案泄露）；options 是 JSON 字符串，parse 成数组返回。
   * 抽不到题（含该专项题池全部被标记）返回空数组（空集合非错误，前端判空显示提示）。
   */
  async startTargetedPractice(input: {
    studentId: number;
    subjectId: number;
    kpId: number;
    type: string | null;
    count: number;
  }): Promise<{ questions: Array<{ questionId: number; text: string; type: string; options: unknown[] | null }> }> {
    const rows = await this.questionsRepo.findRandomByKpAndType(
      input.studentId,
      input.subjectId,
      input.kpId,
      input.type,
      input.count,
    );
    return {
      questions: rows.map((q) => ({
        questionId: q.id,
        text: q.content,
        type: q.type,
        options: parseOptions(q.options),
      })),
    };
  }

  /** 标记某题「不再展示」：校验题目存在（避免标记已删题），再 INSERT IGNORE 幂等写入。 */
  async markHidden(studentId: number, subjectId: number, questionId: number): Promise<void> {
    const q = await this.questionsRepo.findById(questionId);
    if (!q) {
      throw new NotFoundException(`题目不存在：${questionId}`);
    }
    await this.hiddenRepo.mark(studentId, subjectId, questionId);
  }

  /** 撤销单条标记（归属由 repo WHERE student_id 兜底）。 */
  async unmarkHidden(studentId: number, questionId: number): Promise<void> {
    await this.hiddenRepo.unmark(studentId, questionId);
  }

  /** 全部重置：清空该生所有不再展示标记。 */
  async unmarkAllHidden(studentId: number): Promise<void> {
    await this.hiddenRepo.unmarkAll(studentId);
  }

  /** 不再展示清单（按标记时间倒序）。 */
  async listHidden(studentId: number, subjectId: number) {
    return this.hiddenRepo.findAllByStudent(studentId, subjectId);
  }

  /** 批量拉解析：等 in-flight 生成完成（60s），不触发新生成。 */
  async getExplanations(ids: number[]): Promise<{ explanations: Record<number, string | null> }> {
    const clean = ids.filter((x) => Number.isInteger(x) && x > 0);
    const explanations = await this.explanationCache.waitForExplanations(clean);
    return { explanations };
  }

  /** 单题刷新等待：DB 无解析且无在途 -> 重新触发生成；120s 超时；失败写管理员通知（同题同 type 未读去重）。
   *  题目不存在/停用 -> 不触发生成不写通知直接返回 null（findById 已按 is_active=1 过滤，
   *  防枚举不存在 id 触发强模型生成、也防对已删题误发失败通知）。 */
  async waitForExplanation(questionId: number): Promise<{ explanation: string | null }> {
    const q = await this.questionsRepo.findById(questionId);
    if (!q) {
      return { explanation: null };
    }
    const explanation = await this.explanationCache.waitExplanation(questionId, 120_000);
    if (explanation == null) {
      // 超时后重读一次：生成恰在 120s 窗口外完成 -> 直接返回，不写「持续失败」通知（防误报）。
      const after = await this.questionsRepo.findById(questionId);
      if (after?.explanation?.trim()) {
        return { explanation: after.explanation };
      }
      try {
        const hasUnread = await this.notificationsRepo.hasUnreadByQuestion(questionId, 'explanation_failed');
        if (!hasUnread) {
          await this.notificationsRepo.create({
            type: 'explanation_failed',
            questionId,
            title: '题解生成失败',
            content: `题目 #${questionId} 判错后解析生成持续失败（LLM 超时/不可用），请人工补题解。`,
          });
        }
      } catch (err) {
        this.logger.error(`admin notification write failed (questionId=${questionId}): ${err}`);
      }
    }
    return { explanation };
  }
}
