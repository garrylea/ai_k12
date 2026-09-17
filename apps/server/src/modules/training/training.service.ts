import { Injectable, Logger, HttpException, NotFoundException, BadRequestException } from '@nestjs/common';
import { JudgeCoreService } from '../practice/judge-core.service.js';
import { ExplanationCacheService } from '../practice/explanation-cache.service.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { QuestionHintsRepository } from '../../database/repositories/question-hints.repo.js';
import { StudentHiddenQuestionsRepository } from '../../database/repositories/student-hidden-questions.repo.js';
import { AdminNotificationsRepository } from '../../database/repositories/admin-notifications.repo.js';
import { HintCapability } from '../../ai-core/capabilities/hint.capability.js';
import { PointsService } from '../points/points.service.js';
import type { AwardResult } from '../points/points.service.js';
import type { PointsAwardReason } from '../points/dto/points.dto.js';
import {
  ChinesePassagesRepository,
  buildDictationPrompt,
  toSentences,
  toKeyTerms,
} from '../../database/repositories/chinese-passages.repo.js';
import { DictationFeedbackCapability } from '../../ai-core/capabilities/dictation-feedback.capability.js';
import { InterpretationJudgeCapability } from '../../ai-core/capabilities/interpretation-judge.capability.js';
import { parseOptions } from '../../common/utils/parse-options.util.js';
import {
  evaluateDictation,
  normalizeChineseAnswer,
  stripPinyinAnnotation,
  type DictationDiffOp,
} from '../../common/utils/normalize-chinese.util.js';
import type { ErrorBookEntryDto, ErrorBookQueryDto } from './dto/error-book-query.dto.js';
import type {
  DictationPassageListItem,
  DictationQuestionItem,
  DictationJudgeResult,
} from './dto/dictation.dto.js';
import type {
  InterpretationPassageListItem,
  InterpretationPassageItem,
  InterpretationJudgeResult,
  InterpretationMethod,
  InterpretationTermJudgeItem,
  InterpretationSentenceJudgeItem,
} from './dto/interpretation.dto.js';

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
    private readonly interpretationJudge: InterpretationJudgeCapability,
    private readonly pointsService: PointsService,
  ) {}

  /**
   * 默写 / 解释共用：按篇目体裁取档发一次分（甲类逐目标发分，spec §6.1/§7.2）。
   *
   * 三个口径：
   *   1. **一篇一天一次** —— 幂等键 `dict|interp:<studentId>:<passageId>:<todayKey>`，
   *      日期只取 `PointsService.todayKey()`（单一真源，勿在此重写日期格式化）。
   *   2. **体裁未标定不发分、不猜** —— `genre` 只认 `'poem'` / `'prose'`；`null` 或脏值
   *      回 `genre_unset`（spec §4.1 的人工标定前提），并留 warning 让未标定篇目可被发现。
   *   3. **发分失败绝不阻断判题** —— `award()` 抛错只记 warning，按未发分返回。
   *
   * 返回值只报**本次真正入账**的分：`duplicate`（同日重判）时 `award` 会带回首次分值，
   * 那是历史账，一律归 0 且不设 reason，避免前端弹假 `+N 分`（同 Task 10 `awardErrorFixOnClear`）。
   */
  private async awardByPassageGenre(input: {
    studentId: number;
    taskCode: 'cn_dictation' | 'cn_interpretation';
    dedupePrefix: 'dict' | 'interp';
    passageId: number;
    genre: string | null;
  }): Promise<{ pointsAwarded: number; awardReason?: PointsAwardReason }> {
    const { genre } = input;
    if (genre !== 'poem' && genre !== 'prose') {
      this.logger.warn(
        `points award skipped: genre unset (taskCode=${input.taskCode}, `
        + `passageId=${input.passageId}, genre=${String(genre)})`,
      );
      return { pointsAwarded: 0, awardReason: 'genre_unset' };
    }

    let award: AwardResult;
    try {
      award = await this.pointsService.award({
        studentId: input.studentId,
        taskCode: input.taskCode,
        tierKey: genre,
        dedupeKey: `${input.dedupePrefix}:${input.studentId}:${input.passageId}:${this.pointsService.todayKey()}`,
        refType: 'passage',
        refId: input.passageId,
      });
    } catch (err) {
      this.logger.warn(
        `points award failed (taskCode=${input.taskCode}, studentId=${input.studentId}, `
        + `passageId=${input.passageId}): ${err}`,
      );
      return { pointsAwarded: 0 };
    }

    // 干净成功才报分；duplicate 带回的是首次分值（历史账），归 0 且静默。
    if (!award.reason) return { pointsAwarded: award.pointsAwarded };
    if (award.reason === 'daily_limit' || award.reason === 'no_rule' || award.reason === 'tier_inactive') {
      return { pointsAwarded: 0, awardReason: award.reason };
    }
    return { pointsAwarded: 0 };
  }

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
   * 且**不写任何学生状态**（独立化后不入错题本、不清零）——唯一的写入是积分流水
   * （甲类发分 `cn_dictation`，2026-09-17 起按体裁分档，一篇一天一次）。
   *
   * 2026-09-14 起错因文案与判题解耦：本方法只回判题结果（~25ms），
   * 答错时带 `feedbackPending=true`，由前端另调 generateDictationFeedback 取文案。
   * 解耦前错因 LLM 调用在关键路径上——本地 Qwen3.8-27B 是思考模型，
   * 一次错答要等 13–16 秒才看到对错，学生以为卡死。
   */
  async judgeDictation(input: {
    studentId: number;
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

    // 甲类发分（2026-09-17）：一篇一天一次，完成即给、不看对错。发分失败不影响判题。
    const award = await this.awardByPassageGenre({
      studentId: input.studentId,
      taskCode: 'cn_dictation',
      dedupePrefix: 'dict',
      passageId: passage.id,
      genre: passage.genre,
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
      pointsAwarded: award.pointsAwarded,
      awardReason: award.awardReason,
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

  // ==================== 语文古诗文专项：解释（翻译）（2026-09-16） ====================

  /** 解释专项配置页篇目清单（抽题池 = verified=1 且 is_active=1 且**内容就绪**）。
   *  只出篇名 + 册次——释义/译文都是判题答案，一律不下发。 */
  async listInterpretationPassages(): Promise<{ passages: InterpretationPassageListItem[] }> {
    const rows = await this.dictationRepo.findVerifiedForInterpretation();
    return {
      passages: rows.map((r) => ({
        passageId: r.id,
        workTitle: r.work_title,
        semester: r.semester,
      })),
    };
  }

  /**
   * 解释专项开练：指定篇目则按篇目出题（忽略册次），否则按册次（null=全部）随机抽。
   *
   * **整篇所有句子一次下发**——前端才能把整篇铺出来、让学生看见上下文（三行对译不换页）。
   * 题项做白名单序列化：只出 passageId/workTitle/semester/sentences[].{index,text,terms}，
   * `gloss`（释义）/`translation`（译文）/`full_translation` 全部剥离（防答案泄露）。
   */
  async startInterpretation(input: {
    semester: string | null;
    passageIds: number[] | null;
    count: number;
  }): Promise<{ passages: InterpretationPassageItem[] }> {
    const rows = input.passageIds && input.passageIds.length > 0
      ? await this.dictationRepo.findVerifiedByIdsForInterpretation(input.passageIds)
      : await this.dictationRepo.findRandomVerifiedForInterpretation(input.semester, input.count);

    const passages: InterpretationPassageItem[] = [];
    for (const r of rows) {
      const sentences = toSentences(r.sentences);
      // 防御：抽题池已按内容就绪过滤，但手工改库仍可能留下空句集；
      // 下发一篇没有任何句子的篇目会让前端渲染出空白卡片。
      if (sentences.length === 0) continue;
      const terms = toKeyTerms(r.key_terms);
      passages.push({
        passageId: r.id,
        workTitle: r.work_title,
        semester: r.semester,
        sentences: sentences.map((s, index) => ({
          index, // 用数组下标，不用存储值——存储的 sentenceIndex 只用于「term 挂哪句」
          text: s.text,
          terms: terms
            .filter((t) => t.sentenceIndex === index)
            .map((t) => ({
              term: t.term,                            // 原样（带注音），展示用
              plain: stripPinyinAnnotation(t.term),    // 去注音，前端高亮定位用
            })),
        })),
      });
    }
    // 指定篇目路径可能勾选多于 count 个，兜底截断（与 startDictation 同规矩）
    return { passages: passages.slice(0, input.count) };
  }

  /**
   * 解释专项判题：**逐句**判（字词 + 整句翻译），**纯读**、不写任何学生状态
   * （独立子系统：无错题本、无隐藏题、无提示缓存、无自评）——唯一的写入是积分流水
   * （甲类发分 `cn_interpretation`，2026-09-17 起按体裁分档，一篇一天一次）。
   *
   * 顺序是刻意的：
   *   1. 程序短路掉能确定的项（空答案 → unanswered；归一化全等 → exact），**不进 LLM**；
   *   2. 剩下的待判项**打包一次**调用（同一句的字词 + 整句合成一次请求，省往返）；
   *   3. 模型漏项 / 整次失败 → 逐项 `undetermined`，**已判项不清空、不抛错**
   *      ——判题服务不可用不该让学生连「哪些已经对了」都看不到。
   */
  async judgeInterpretation(input: {
    studentId: number;
    passageId: number;
    sentenceIndex: number;
    terms: Array<{ term: string; answer: string }>;
    translation: string;
  }): Promise<InterpretationJudgeResult> {
    const passage = await this.dictationRepo.findById(input.passageId);
    if (!passage) {
      throw new NotFoundException(`解释篇目不存在：${input.passageId}`);
    }

    const sentences = toSentences(passage.sentences);
    const std = sentences[input.sentenceIndex];
    if (!std) {
      throw new BadRequestException(`sentenceIndex 越界：${input.sentenceIndex}`);
    }
    const stdTerms = toKeyTerms(passage.key_terms).filter((t) => t.sentenceIndex === input.sentenceIndex);

    // 学生答案配对：同名取最后一条，多传的 term 忽略（服务端只认该句「应有」的字词）
    const answerByTerm = new Map<string, string>();
    for (const t of input.terms) answerByTerm.set(t.term.trim(), t.answer);
    const answerOf = (term: string) => answerByTerm.get(term.trim()) ?? '';

    // ---- 1. 程序短路 ----
    type TermSlot = InterpretationTermJudgeItem & { pending: boolean };
    const slots: TermSlot[] = stdTerms.map((t) => {
      const stu = answerOf(t.term);
      if (stu.trim() === '') {
        return { term: t.term, correct: false, method: 'unanswered', standard: t.gloss, comment: null, pending: false };
      }
      if (normalizeChineseAnswer(stu) === normalizeChineseAnswer(t.gloss)) {
        return { term: t.term, correct: true, method: 'exact', standard: t.gloss, comment: null, pending: false };
      }
      // 先占位为 undetermined：LLM 补判成功会覆盖，漏项/失败就保持 undetermined
      return { term: t.term, correct: null, method: 'undetermined', standard: t.gloss, comment: null, pending: true };
    });

    type SentenceSlot = InterpretationSentenceJudgeItem & { pending: boolean };
    let sentSlot: SentenceSlot;
    if (input.translation.trim() === '') {
      sentSlot = { correct: false, method: 'unanswered', standard: std.translation, comment: null, pending: false };
    } else if (normalizeChineseAnswer(input.translation) === normalizeChineseAnswer(std.translation)) {
      sentSlot = { correct: true, method: 'exact', standard: std.translation, comment: null, pending: false };
    } else {
      sentSlot = { correct: null, method: 'undetermined', standard: std.translation, comment: null, pending: true };
    }

    // ---- 2. 待判项打包一次调用 ----
    const pendingTerms = slots.filter((s) => s.pending);
    if (pendingTerms.length > 0 || sentSlot.pending) {
      try {
        const judged = await this.interpretationJudge.generate({
          workTitle: passage.work_title,
          sentence: std.text,
          standardTranslation: std.translation,
          studentTranslation: sentSlot.pending ? input.translation : null,
          terms: pendingTerms.map((s) => ({ term: s.term, gloss: s.standard, answer: answerOf(s.term) })),
        });

        for (const s of pendingTerms) {
          const hit = judged.terms.find((r) => r.term.trim() === s.term.trim());
          if (hit) {
            s.correct = hit.correct;
            s.method = 'ai';
            s.comment = hit.comment ?? null;
          }
          s.pending = false; // 漏项保持 undetermined
        }
        if (sentSlot.pending) {
          if (judged.sentence) {
            sentSlot.correct = judged.sentence.correct;
            sentSlot.method = 'ai';
            sentSlot.comment = judged.sentence.comment ?? null;
          }
          sentSlot.pending = false;
        }
      } catch (err) {
        this.logger.warn(
          `interpretationJudge.generate failed (passageId=${input.passageId}, sentenceIndex=${input.sentenceIndex}): ${err}`,
        );
        // 兜底：待判项全部保持 undetermined；**短路判出的项不受影响**
        for (const s of pendingTerms) s.pending = false;
        sentSlot.pending = false;
      }
    }

    const termItems: InterpretationTermJudgeItem[] = slots.map(({ pending: _pending, ...rest }) => rest);

    // 甲类发分（2026-09-17）：一篇一天一次、按体裁分档。判题是**逐句**的，
    // 所以首句判完即发；同日后续句子会命中幂等键（duplicate → 归 0 静默）。
    const award = await this.awardByPassageGenre({
      studentId: input.studentId,
      taskCode: 'cn_interpretation',
      dedupePrefix: 'interp',
      passageId: passage.id,
      genre: passage.genre,
    });

    return {
      passageId: passage.id,
      sentenceIndex: input.sentenceIndex,
      allCorrect: termItems.every((t) => t.correct === true) && sentSlot.correct === true,
      terms: termItems,
      sentence: {
        correct: sentSlot.correct,
        method: sentSlot.method,
        standard: sentSlot.standard,
        comment: sentSlot.comment,
      },
      // 整篇译文只在最后一句判完时给——提前给等于把整篇答案交出去
      fullTranslation: input.sentenceIndex === sentences.length - 1
        ? (passage.full_translation ?? null)
        : null,
      pointsAwarded: award.pointsAwarded,
      awardReason: award.awardReason,
    };
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
