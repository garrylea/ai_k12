import { Injectable, Logger, HttpException } from '@nestjs/common';
import { QuestionsRepository, MainErrorBooksRepository, QuestionSelfAssessmentsRepository } from '../../database/repositories/index.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';
import { JudgmentCapability } from '../../ai-core/capabilities/judgment.capability.js';
import { ExplanationCacheService } from './explanation-cache.service.js';
import { PointsService, type AwardResult } from '../points/points.service.js';
import { computeContentHash } from '../../common/utils/content-hash.util.js';
import { evaluateDictation, type DictationDiffOp } from '../../common/utils/normalize-chinese.util.js';
import type { QuestionRow } from '../../database/repositories/types.js';

/** 仅走 exact 比对的客观题：选项/判断标签形式固定，可靠，不等即判错。
 *  fill_blank 答案形式多样（如 2/3 vs \frac{2}{3}），命中时单独处理：归一化相等走 exact，不等走 AI 复核。 */
const EXACT_ONLY_TYPES = new Set(['choice', 'true_false']);

/** 主观题（解答/证明）：self_assess 模式下不判对错，学生对照参考答案自评。 */
export const SUBJECTIVE_TYPES = new Set(['short_answer', 'proof']);

/** 主观题判题模式：self_assess（默认，学生自评）| ai（现有 JudgmentCapability 判对错，
 *  预留国产模型能力提升后切回——只改环境变量，代码路径全保留）。 */
export type SubjectiveJudgeMode = 'self_assess' | 'ai';
export function subjectiveJudgeMode(): SubjectiveJudgeMode {
  return process.env.JUDGE_SUBJECTIVE_MODE === 'ai' ? 'ai' : 'self_assess';
}

/** 答案归一：NFKC 全半角归一 + 去空白 + 去 $ + LaTeX \frac{a}{b}->a/b（递归）+ 转小写。 */
export function normalizeAnswer(s: string): string {
  let r = (s || '').normalize('NFKC').replace(/\s+/g, '').replace(/\$+/g, '');
  // \frac{a}{b} / \dfrac{a}{b} -> a/b（递归处理嵌套，使 2/3 与 \frac{2}{3} 归一相同）
  let prev: string;
  do {
    prev = r;
    r = r.replace(/\\d?frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2');
  } while (r !== prev);
  return r.toLowerCase();
}

/**
 * 客观题答案比对。
 * 优先按 options 中的 isCorrect 标记判定（选择题）；
 * 若 options 解析失败或未命中，退化为归一化字符串相等比对。
 */
export function compareAnswer(studentAnswer: string, correctAnswer: string, options: string | null): boolean {
  const a = normalizeAnswer(studentAnswer);
  if (!a) return false;
  if (options) {
    try {
      const opts = JSON.parse(options) as Array<{ label: string; isCorrect?: boolean }>;
      const picked = opts.find(o => normalizeAnswer(o.label) === a);
      // 仅当 options 显式标注 isCorrect 时用它判定；否则退化为与 correctAnswer 标签比对
      // （题库 choice 题常只存 answer="A" 而 options 无 isCorrect 标记）
      if (picked && typeof picked.isCorrect === 'boolean') return picked.isCorrect;
    } catch {
      /* fallthrough to string compare */
    }
  }
  return a === normalizeAnswer(correctAnswer);
}

export interface JudgeInput {
  studentId: number;
  subjectId: number;
  cardId: number;
  lessonId: number;
  questionN: string;
  questionText: string;
  studentAnswer: string;
}

export interface JudgeOutput {
  questionId: number | null;
  /** null = 未判定（主观题 self_assess 待自评 / 客观题空答案不计对错） */
  isCorrect: boolean | null;
  method: 'exact' | 'ai' | 'self_assess' | 'unanswered';
  errorType: 'logic' | 'calculation' | 'format' | 'missing' | null;
  errorBookId: number | undefined;
  /**
   * 本次调用**实际入账**的积分（甲类逐目标发分，spec §7.2）。
   * 0 = 本次没有加分：答错 / `source='exam'` / 未清零（`cleared=0`）/ 无题库身份
   * （`questionId=null`）/ 幂等命中（`duplicate`，`PointsService.award` 会返回首次分值，
   * 但那是历史账、本次未入账）/ `daily_limit` / `no_rule` / `tier_inactive` / 发分失败。
   * 前端 `> 0` 弹 `+N 分` 轻反馈。
   */
  pointsAwarded: number;
  /**
   * 未发分原因（有值时可给差异化文案，无值静默）：
   * - `not_cleared`：答对但本无未清错题行（`cleared === 0`），没有可订正的错题，故不发分；
   * - `daily_limit` / `no_rule` / `tier_inactive`：透传 `PointsService.award` 的业务拒发原因。
   *
   * 注意 `duplicate` **不在枚举内**：幂等命中时本次没入账，`pointsAwarded=0` 且静默，
   * 不能给前端「+N 分」的假反馈。
   */
  awardReason?: 'daily_limit' | 'no_rule' | 'tier_inactive' | 'not_cleared';
  /** 主观题 self_assess 模式：前端据此渲染自评 UI。 */
  needsSelfAssessment?: boolean;
  /** 自评展示用（判题时一并带回，省一次往返）。 */
  referenceAnswer?: string | null;
  explanation?: string | null;
  /** 客观题空答案：该题暂无标准答案，不计对错（课堂练习守卫）。 */
  noStandardAnswer?: boolean;
}

export interface JudgeCoreQuestionInput {
  studentId: number;
  subjectId: number;
  questionId: number;        // 题中心：必传（训练题必来自题库）
  studentAnswer: string;
  source: string;            // 'targeted' | 'error_practice' | 'exam' | 'practice'
  sourceRefId?: number | null; // 考试传 session_id；practice 沿用现结构不经过此变体
}

export interface JudgeDictationInput {
  expected: { author: string; dynasty: string; body: string };
  student: { author: string; dynasty: string; body: string };
}

export interface JudgeDictationOutput {
  isCorrect: boolean;
  method: 'exact';
  fields: { author: { match: boolean }; dynasty: { match: boolean }; body: { match: boolean } };
  bodyDiff: DictationDiffOp[];
}

/**
 * 判题核心：三路由（exact / fill_blank 归一 / AI）+ 错题本写入/清零。
 * 从 PracticeService.judge 抽取，供 practice（card 中心）与训练模块（题中心）复用。
 * 不写 practice_results（card_id NOT NULL 的卡上下文持久化留在 PracticeService）。
 */
@Injectable()
export class JudgeCoreService {
  private readonly logger = new Logger(JudgeCoreService.name);

  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly structuring: QuestionStructuringCapability,
    private readonly judgment: JudgmentCapability,
    private readonly explanationCache: ExplanationCacheService,
    private readonly selfAssessRepo: QuestionSelfAssessmentsRepository,
    private readonly pointsService: PointsService,
  ) {}

  /** 题中心判题（训练模块专用入口）。q 恒非空，无「未命中 AI+结构化」分支。 */
  async judgeQuestion(input: JudgeCoreQuestionInput): Promise<JudgeOutput> {
    const q = await this.questionsRepo.findById(input.questionId);
    if (!q) {
      throw new HttpException({ code: 4004, message: '题目不存在' }, 400);
    }

    let isCorrect: boolean | null;
    let method: JudgeOutput['method'];
    let errorType: 'logic' | 'calculation' | 'format' | 'missing' | null = null;
    // 甲类逐目标发分（error_fix）：默认 0，仅清零确实命中未清行且非考试来源时改变。
    let pointsAwarded = 0;
    let awardReason: JudgeOutput['awardReason'];

    // 路由 0（判题体系重构）：空答案守卫（与 judgeForPractice 路由 0 条件一字不差）——
    // 训练抽题虽已过滤空答案（Task 4），但 error_practice 从错题本重抽不过滤：
    // 空答案题落到 AI 判定会产生无依据判错 + 错题 level 提升；主观题空答案则无
    // 参考答案可自评。不计对错、不入错题本、不触发解析生成。
    if (!q.answer || !q.answer.trim()) {
      return { questionId: q.id, isCorrect: null, method: 'unanswered', errorType: null, errorBookId: undefined, noStandardAnswer: true, pointsAwarded: 0 };
    }

    if (EXACT_ONLY_TYPES.has(q.type)) {
      // 路由 1：choice/true_false -> exact 比对（标签形式固定，可靠）
      isCorrect = compareAnswer(input.studentAnswer, q.answer, q.options);
      method = 'exact';
    } else if ((q.type === 'fill_blank' || q.type === 'calculation') && compareAnswer(input.studentAnswer, q.answer, q.options)) {
      // 路由 1b：fill_blank/calculation 归一化相等 -> exact 判对（省 AI）；不等走 AI 复核
      isCorrect = true;
      method = 'exact';
    } else if (SUBJECTIVE_TYPES.has(q.type) && subjectiveJudgeMode() === 'self_assess') {
      // 路由 1c（判题体系重构 2026-09-09）：主观题 self_assess 模式 -> 不判对错。
      // 参考答案/解析随判题返回（前端当场展开自评）；错题本与清零由自评端点处理。
      return {
        questionId: q.id,
        isCorrect: null,
        method: 'self_assess',
        errorType: null,
        errorBookId: undefined,
        needsSelfAssessment: true,
        referenceAnswer: q.answer,
        explanation: q.explanation,
        pointsAwarded: 0,
      };
    } else {
      // 路由 2：fill_blank 不等 / short_answer / proof -> AI 判定
      const questionType = q.type === 'proof' ? 'proof' : 'calculation';
      // spec §11: AI 判定失败 -> 503，不进错题本，前端可区分处理。
      try {
        const result = await this.judgment.judge({
          questionContent: q.content,
          standardAnswer: q.answer ?? '',
          reference: q.explanation ?? '',
          studentAnswer: input.studentAnswer,
          subject: 'math',
          questionType,
        });
        isCorrect = result.isCorrect;
        errorType = result.errorType ?? null;
      } catch (err) {
        this.logger.error(`judgment.judge failed: ${err}`);
        throw new HttpException(
          { code: 5001, message: '判定失败，请重试' },
          503,
        );
      }
      method = 'ai';
    }

    let errorBookId: number | undefined;

    if (!isCorrect) {
      // 答错 -> 触发解析缓存生成（fire-and-forget；q 必非空，explanation 已有/长答案直写，见 ExplanationCacheService）
      this.explanationCache.ensureExplanation(q);
      // 答错 -> 入主线错题本（find-or-create，避免重复答错堆积）
      errorBookId = await this.writeErrorBookOrReuse({
        studentId: input.studentId,
        subjectId: input.subjectId,
        questionId: input.questionId,
        source: input.source,
        sourceRefId: input.sourceRefId,
      });
    } else {
      // 答对 -> 清零该题所有未清错题记录（不限 source；best-effort，失败不阻断）
      try {
        const cleared = await this.mainErrorRepo.clearUnclearedByStudentQuestionId(input.studentId, input.questionId);
        // source='exam' 排除：交卷补判在途题不得额外发订正分（考试分只由 math_paper 一次性给）。
        // 「清掉几条 -> 发不发分」的判决统一在 awardErrorFixOnClear（与 card 路径同一实现）。
        if (input.source !== 'exam') {
          const award = await this.awardErrorFixOnClear(input.studentId, input.questionId, cleared);
          pointsAwarded = award.pointsAwarded;
          awardReason = award.awardReason;
        }
      } catch (err) {
        this.logger.error(`clearUnclearedByStudentQuestionId failed (student=${input.studentId}, question=${input.questionId}): ${err}`);
      }
    }

    return { questionId: q.id, isCorrect, method, errorType, errorBookId, pointsAwarded, awardReason };
  }

  /**
   * 语文古诗文默写判题：**纯程序化**，不调用任何 LLM，**不写任何学生状态**。
   *
   * 对错完全由「归一化后逐字段全等」决定（三项全对才算对）；正文错处由 LCS 差异定位。
   * 错因文案由调用方（TrainingService）在判题之后单独调 DictationFeedbackCapability，
   * 失败不影响本方法返回值。
   *
   * 2026-09-15 独立化：**不再查 questions、不再写/清错题本**。篇目身份与存在性由调用方
   * （TrainingService，走 ChinesePassagesRepository）负责——本方法现在只做纯函数判题。
   * 错题本的三项机制（重做—清零 / 级别递进 / 错题练习数据源）对篇目级作答都没有落点，
   * 见 docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md §2。
   *
   * 不调用 ExplanationCacheService.ensureExplanation：它的「answer >= 100 字直写解析」
   * 规则会让长文言文的解析变成「解析 = 正文」（设计 spec §5 第 6 步）。
   */
  async judgeDictation(input: JudgeDictationInput): Promise<JudgeDictationOutput> {
    // bodyDiff 已回投原文标点，学生看到的是带标点的整句，判对错口径不受影响。
    const { isCorrect, fields, bodyDiff } = evaluateDictation(input.expected, input.student);
    return { isCorrect, method: 'exact', fields, bodyDiff };
  }

  /** card 中心判题（PracticeService.judge 委托，行为保持）。q 可为 null -> AI + 结构化入库路径。 */
  async judgeForPractice(input: JudgeInput, q: QuestionRow | null): Promise<JudgeOutput> {
    let isCorrect: boolean | null;
    let method: JudgeOutput['method'];
    let errorType: 'logic' | 'calculation' | 'format' | 'missing' | null = null;
    // 甲类逐目标发分（error_fix）：card 路径同样参与（spec §6.5 明确「无论入口是错题专项
    // 还是主线清零阶段都走这一个函数」，主线清零 UI 正是这条 judgePractice 路径）。
    let pointsAwarded = 0;
    let awardReason: JudgeOutput['awardReason'];

    // 路由 0（判题体系重构）：空答案守卫（全题型，条件与 judgeQuestion 路由 0 一字不差）——
    // 客观题空答案会被判错污染错题本；主观题（short_answer/proof）空答案进路由 1c 只会
    // 返回空参考答案，学生无从自评。故统一不计对错、不入错题本、不触发解析生成。
    // practice_results 由 PracticeService 以 method='unanswered' 落行（保证课程完成
    // 门禁的作答覆盖计数不缺行）。
    if (q && (!q.answer || !q.answer.trim())) {
      return { questionId: q.id, isCorrect: null, method: 'unanswered', errorType: null, errorBookId: undefined, noStandardAnswer: true, pointsAwarded: 0 };
    }

    if (q && EXACT_ONLY_TYPES.has(q.type)) {
      // 路由 1：choice/true_false 命中 -> exact 比对（标签形式固定，可靠）
      isCorrect = compareAnswer(input.studentAnswer, q.answer, q.options);
      method = 'exact';
    } else if (q && (q.type === 'fill_blank' || q.type === 'calculation') && compareAnswer(input.studentAnswer, q.answer, q.options)) {
      // 路由 1b：fill_blank/calculation 命中且归一化相等 -> exact 判对（省 AI）。
      // 不等则落到路由 2 走 AI，避免 2/3 vs \frac{2}{3} 等形式差异被误判错。
      isCorrect = true;
      method = 'exact';
    } else if (q && SUBJECTIVE_TYPES.has(q.type) && subjectiveJudgeMode() === 'self_assess') {
      // 路由 1c（判题体系重构 2026-09-09）：主观题 self_assess 模式 -> 不判对错。
      // 参考答案/解析随判题返回（前端当场展开自评）；错题本与清零由自评端点处理。
      return {
        questionId: q.id,
        isCorrect: null,
        method: 'self_assess',
        errorType: null,
        errorBookId: undefined,
        needsSelfAssessment: true,
        referenceAnswer: q.answer,
        explanation: q.explanation,
        pointsAwarded: 0,
      };
    } else {
      // 路由 2：fill_blank 不等 / short_answer / proof / 未命中 -> AI 判定
      const questionType = q?.type === 'proof' ? 'proof' : 'calculation';
      // spec §11: AI 判定失败 -> 503，不进错题本，前端可区分处理。
      // 参考 ai.service.ts mapLLMError 的错误风格（code 5001, HTTP 503）。
      try {
        const result = await this.judgment.judge({
          questionContent: input.questionText,
          standardAnswer: q?.answer ?? '',
          reference: q?.explanation ?? '',
          studentAnswer: input.studentAnswer,
          subject: 'math',
          questionType,
        });
        isCorrect = result.isCorrect;
        errorType = result.errorType ?? null;
      } catch (err) {
        this.logger.error(`judgment.judge failed: ${err}`);
        throw new HttpException(
          { code: 5001, message: '判定失败，请重试' },
          503,
        );
      }
      method = 'ai';
    }

    let questionId: number | null = q?.id ?? null;
    let errorBookId: number | undefined;

    // 路由 3：答错 -> 入主线错题本（find-or-create，避免重复答错堆积；未入库的题先结构化 + 插题）
    if (!isCorrect) {
      // 判错 -> 触发解析缓存生成（fire-and-forget；explanation 已有/长答案直写，见 ExplanationCacheService）
      if (q) {
        this.explanationCache.ensureExplanation(q);
      }
      let questionCreated = false;
      if (!q) {
        // Important #1: structure/findOrCreate 失败不得阻断错题入库 --
        // catch 里记日志、questionId=null，继续往下执行 mainErrorRepo.create
        //（与 quality=poor 路径一致：wrong_answer_text 存题面）。
        try {
          const structured = await this.structuring.structure({
            rawInput: input.questionText,
            inputType: 'text',
            studentId: String(input.studentId),
            subjectHint: 'math',
          });
          if (structured.quality !== 'poor' && structured.content.trim().length > 0) {
            const created = await this.questionsRepo.findOrCreate({
              subject_id: input.subjectId,
              type: structured.type,
              difficulty: structured.difficulty,
              content: structured.content,
              options: structured.options ? JSON.stringify(structured.options) : null,
              answer: structured.answer,
              explanation: structured.explanation,
              source: 'practice',
              content_hash: computeContentHash(structured.content),
            });
            questionId = created.id;
            // 仅真正新建（created.created）时触发解析缓存生成：命中既有题时其解析由
            // 判错后对 DB 行 q 的 ensureExplanation 处理，避免长答案直写覆盖既有解析。
            if (created.created) {
              this.explanationCache.ensureExplanation({ id: created.id, answer: structured.answer, explanation: structured.explanation });
            }
            questionCreated = created.created;
          } else {
            questionId = null;
          }
        } catch (err) {
          this.logger.error(`structure/findOrCreate failed, falling back to questionId=null: ${err}`);
          questionId = null;
        }
      }
      // find-or-create：命中既有未清错题则复用（不重复 create）；否则新建（孤儿题回滚补偿仅新建分支）
      const existing = await this.mainErrorRepo.findUnclearedByStudentQuestion(
        input.studentId,
        questionId,
        input.cardId,
        input.questionText,
      );
      if (existing) {
        errorBookId = existing.id;
      } else {
        // Important #2: 孤儿题补偿 -- mainErrorRepo.create 失败时若刚创建了题，
        // 删除孤儿题再抛（镜像 ErrorBookService.insertQuestionAndAux）。
        try {
          errorBookId = await this.mainErrorRepo.create({
            student_id: input.studentId,
            subject_id: input.subjectId,
            question_id: questionId,
            source: 'practice',
            source_ref_id: input.cardId,
            question_n: input.questionN,
            lesson_id: input.lessonId,
            wrong_answer_text: questionId === null ? input.questionText : null,
          });
        } catch (err) {
          if (questionCreated && questionId !== null) {
            await this.questionsRepo.deleteById(questionId).catch(() => {});
          }
          throw err;
        }
      }
    } else {
      // 答对 -> 清零该题未清错题记录（展示掌握，影响跨课门禁计数；best-effort，失败不阻断）
      try {
        const cleared = await this.mainErrorRepo.clearUnclearedByStudentQuestion(
          input.studentId,
          questionId,
          input.cardId,
          input.questionText,
        );
        // 确实清掉一条未清错题 -> 发 error_fix（与题中心 judgeQuestion 同一判决函数）。
        // questionId=null（题库未命中、仅存题面）时 helper 刻意不发分，因为没有稳定幂等身份。
        const award = await this.awardErrorFixOnClear(input.studentId, questionId, cleared);
        pointsAwarded = award.pointsAwarded;
        awardReason = award.awardReason;
      } catch (err) {
        this.logger.error(`clearUnclearedByStudentQuestion failed (student=${input.studentId}, card=${input.cardId}, qn=${input.questionN}): ${err}`);
      }
    }

    return { questionId, isCorrect, method, errorType, errorBookId, pointsAwarded, awardReason };
  }

  /**
   * 清零之后按需发 `error_fix` 分（错题订正）——**所有清零入口的唯一发分判决**。
   * card 中心（`judgeForPractice` / `PracticeService.selfAssess`）与题中心（`judgeQuestion` /
   * `recordSelfAssessment`）都调它，避免各自复制「gate + 幂等键」逻辑（spec §6.5/§7.2）。
   *
   * `cleared` = 本次清零 SQL 的 `affectedRows`。两个条件，缺一不发：
   *   1. `cleared > 0`：「确实清掉了一条未清零的错题」。首次就答对（本无错题行）、
   *      已清零后再做对都是 `0`，不发分，并回 `not_cleared` 供前端差异化文案。
   *   2. `questionId != null`：只有题库题才有稳定身份拼幂等键。**仅存题面**的错题
   *      （`question_id` 为 null）**刻意不发分**——题面可被一次无关编辑改掉，用题面
   *      派生 key 等于给同一道错题发第二次分。见 spec §4.4/§6.5。
   *
   * 幂等键 `err:<studentId>:<questionId>:<todayKey>`：同日同题重判不重复发分，跨天可再次订正。
   * 日期只取 `PointsService.todayKey()`，不在此重写日期格式化（单一真源）。
   *
   * 返回值只报**本次真正入账**的分：`PointsService.award` 在幂等命中（`duplicate`）时
   * 会返回首次分值，那是历史账、本次未入账 —— 一律归 0，避免前端弹假 `+N 分`（Finding C1）。
   *
   * 刻意吞异常：积分是激励层，发分失败绝不能挡住判题（镜像 exams 的 awardPaperPoints）。
   */
  async awardErrorFixOnClear(
    studentId: number,
    questionId: number | null,
    cleared: number,
  ): Promise<{ pointsAwarded: number; awardReason?: JudgeOutput['awardReason'] }> {
    if (cleared === 0) {
      // 无可订正目标（spec §7.2 枚举的 not_cleared）。
      return { pointsAwarded: 0, awardReason: 'not_cleared' };
    }
    if (questionId == null) {
      // 仅存题面的错题没有稳定幂等身份：不发分（宁可少发，也不发可被编辑绕过的第二次分）。
      this.logger.debug(
        `error_fix skipped: cleared=${cleared} but questionId is null (student=${studentId})`,
      );
      return { pointsAwarded: 0 };
    }

    const award = await this.awardErrorFix(studentId, questionId);
    // award 失败（null）时保持 0/undefined —— 积分失败绝不改变判题结果。
    if (!award) return { pointsAwarded: 0 };

    const result: { pointsAwarded: number; awardReason?: JudgeOutput['awardReason'] } = {
      // 只有干净成功（无 reason）才报 award.pointsAwarded。`duplicate` 会带首次分值回来，
      // 直接透传就是假分（Finding C1）；其它 reason 本就 pointsAwarded=0。
      pointsAwarded: award.reason ? 0 : award.pointsAwarded,
    };
    if (award.reason === 'daily_limit' || award.reason === 'no_rule' || award.reason === 'tier_inactive') {
      result.awardReason = award.reason;
    }
    return result;
  }

  /**
   * 错题订正发分（`error_fix`）的底层写账调用。业务判决见 `awardErrorFixOnClear`。
   *
   * 刻意吞异常：积分是激励层，发分失败绝不能挡住判题（镜像 exams 的 awardPaperPoints）。
   * 返回 `AwardResult`（含 `pointsAwarded` / `reason`）；发分失败返回 `null`
   * （调用方保持 pointsAwarded=0、awardReason 不设，判题照常返回）。
   */
  private async awardErrorFix(studentId: number, questionId: number): Promise<AwardResult | null> {
    try {
      return await this.pointsService.award({
        studentId,
        taskCode: 'error_fix',
        dedupeKey: `err:${studentId}:${questionId}:${this.pointsService.todayKey()}`,
        refType: 'question',
        refId: questionId,
      });
    } catch (err) {
      this.logger.warn(`awardErrorFix failed (student=${studentId}, question=${questionId}): ${err}`);
      return null;
    }
  }

  /** 错题本 find-or-create（题中心：命中未清行复用，否则新建）。judgeQuestion 答错与自评 incorrect 共用。 */
  private async writeErrorBookOrReuse(input: {
    studentId: number; subjectId: number; questionId: number;
    source: string; sourceRefId?: number | null;
  }): Promise<number> {
    const existing = await this.mainErrorRepo.findUnclearedByStudentQuestionId(input.studentId, input.questionId);
    if (existing) return existing.id;
    return this.mainErrorRepo.create({
      student_id: input.studentId,
      subject_id: input.subjectId,
      question_id: input.questionId,
      source: input.source,
      source_ref_id: input.sourceRefId ?? null,
      question_n: null,
      lesson_id: null,
      wrong_answer_text: null,
    });
  }

  /**
   * 主观题自评落库（self_assess 模式，训练/考试/课堂练习自评端点共用）：
   * 自评留痕（question_self_assessments）+ 错题本写入/清零——镜像判题的答错/答对路径，
   * 「错题清零」门禁因此零改动（主观题错题与客观题错题在 main_error_books 形态一致）。
   *
   * 自评对且**确实清掉未清错题**时按 `error_fix` 发分（走 `awardErrorFixOnClear` 同一判决）；
   * `source='exam'` 排除（考试分只由 math_paper 一次性给）。
   */
  async recordSelfAssessment(input: {
    studentId: number;
    subjectId: number;
    questionId: number;
    assessment: 'correct' | 'incorrect';
    source: string;
    sourceRefId?: number | null;
  }): Promise<{ errorBookId: number | undefined }> {
    await this.selfAssessRepo.create({
      studentId: input.studentId,
      questionId: input.questionId,
      assessment: input.assessment,
      source: input.source,
    });
    if (input.assessment === 'incorrect') {
      const errorBookId = await this.writeErrorBookOrReuse({
        studentId: input.studentId,
        subjectId: input.subjectId,
        questionId: input.questionId,
        source: input.source,
        sourceRefId: input.sourceRefId,
      });
      return { errorBookId };
    }
    // 自评对 -> 清零（best-effort，失败不阻断）
    try {
      const cleared = await this.mainErrorRepo.clearUnclearedByStudentQuestionId(input.studentId, input.questionId);
      // source='exam'（考试结果页自评）与 judgeQuestion 同款排除：考试分只由 math_paper
      // 一次性给，自评答对不得冒出额外的订正分。
      if (input.source !== 'exam') {
        await this.awardErrorFixOnClear(input.studentId, input.questionId, cleared);
      }
    } catch (err) {
      this.logger.error(`clearUnclearedByStudentQuestionId failed (self-assess, student=${input.studentId}, question=${input.questionId}): ${err}`);
    }
    return { errorBookId: undefined };
  }
}
