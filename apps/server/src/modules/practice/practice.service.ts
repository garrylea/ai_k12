import { Injectable, Logger, HttpException } from '@nestjs/common';
import { QuestionsRepository, MainErrorBooksRepository, CardsRepository, PracticeResultsRepository, ProgressRepository } from '../../database/repositories/index.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';
import { JudgmentCapability } from '../../ai-core/capabilities/judgment.capability.js';
import { HintCapability } from '../../ai-core/capabilities/hint.capability.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { ContentService } from '../content/content.service.js';
import { computeContentHash } from '../../common/utils/content-hash.util.js';
import type { QuestionRow } from '../../database/repositories/types.js';

/** 仅走 exact 比对的客观题：选项/判断标签形式固定，可靠，不等即判错。
 *  fill_blank 答案形式多样（如 2/3 vs \frac{2}{3}），命中时单独处理：归一化相等走 exact，不等走 AI 复核。 */
const EXACT_ONLY_TYPES = new Set(['choice', 'true_false']);

/** 答案归一：NFKC 全半角归一 + 去空白 + 去 $ + LaTeX \frac{a}{b}->a/b（递归）+ 转小写。 */
function normalizeAnswer(s: string): string {
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
function compareAnswer(studentAnswer: string, correctAnswer: string, options: string | null): boolean {
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
  isCorrect: boolean;
  method: 'exact' | 'ai';
  analysis: string | null;
  errorType: 'logic' | 'calculation' | 'format' | 'missing' | null;
  errorBookId: number | undefined;
}

export interface PracticeResultDto {
  questionN: string;
  questionText: string;
  studentAnswer: string;
  isCorrect: boolean;
  method: 'exact' | 'ai';
  analysis: string | null;
  errorType: 'logic' | 'calculation' | 'format' | 'missing' | null;
}

export interface HintInput {
  /** 当前未用于 getHint，保留以与 JudgeInput 对齐（未来按课时取知识点上下文）。 */
  studentId: number;
  subjectId: number;
  cardId: number;
  lessonId: number;
  /** 题目文本，同时作为 cards.hints JSON 的 key（即「题目标题」）。 */
  questionText: string;
}

export interface HintOutput {
  hint: string;
  /** true = 命中 cards.hints 缓存直返（未调 AI）；false = 本次新生成并已写回缓存。 */
  cached: boolean;
}

export interface DiscussInput {
  studentId: number;
  subjectId: number;
  cardId: number;
  lessonId: number;
  /** 题目文本：作为错题去重键（question_id 为空时按题面匹配）。 */
  questionText: string;
}

export interface DiscussOutput {
  /** mainline 对话 id，前端据此走 /api/ai/tutor/stream 做苏格拉底讨论。 */
  dialogueId: string;
  /** 本次命中或新建的错题本记录 id。 */
  errorBookId: number;
  /** 题库中的题目 id（未命中为 null）。 */
  questionId: number | null;
}

/** 卡片级「思辨答疑」入参：讨论整张卡片的知识，无具体题目，不入错题本。 */
export interface DiscussCardInput {
  studentId: number;
  subjectId: number;
  cardId: number;
  lessonId: number;
}

export interface DiscussCardOutput {
  /** mainline 对话 id（find-or-create：复用该卡已有讨论，否则新建）。 */
  dialogueId: string;
}

@Injectable()
export class PracticeService {
  private readonly logger = new Logger(PracticeService.name);

  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly structuring: QuestionStructuringCapability,
    private readonly judgment: JudgmentCapability,
    private readonly cardsRepo: CardsRepository,
    private readonly hint: HintCapability,
    private readonly conversationsService: ConversationsService,
    private readonly practiceResultsRepo: PracticeResultsRepository,
    private readonly contentService: ContentService,
    private readonly progressRepo: ProgressRepository,
  ) {}

  async judge(input: JudgeInput): Promise<JudgeOutput> {
    const contentHash = computeContentHash(input.questionText);
    const q: QuestionRow | null = await this.questionsRepo.findByContentHash(contentHash);

    let isCorrect: boolean;
    let method: 'exact' | 'ai';
    let analysis: string | null = null;
    let errorType: 'logic' | 'calculation' | 'format' | 'missing' | null = null;

    if (q && EXACT_ONLY_TYPES.has(q.type)) {
      // 路由 1：choice/true_false 命中 -> exact 比对（标签形式固定，可靠）
      isCorrect = compareAnswer(input.studentAnswer, q.answer, q.options);
      method = 'exact';
      analysis = isCorrect ? null : `正确答案：${q.answer}`;
    } else if (q && q.type === 'fill_blank' && compareAnswer(input.studentAnswer, q.answer, q.options)) {
      // 路由 1b：fill_blank 命中且归一化相等 -> exact 判对（省 AI）。
      // 不等则落到路由 2 走 AI，避免 2/3 vs \frac{2}{3} 等形式差异被误判错。
      isCorrect = true;
      method = 'exact';
      analysis = null;
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
        analysis = isCorrect ? null : result.analysis;
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
        await this.mainErrorRepo.clearUnclearedByStudentQuestion(
          input.studentId,
          questionId,
          input.cardId,
          input.questionText,
        );
      } catch (err) {
        this.logger.error(`clearUnclearedByStudentQuestion failed (student=${input.studentId}, card=${input.cardId}, qn=${input.questionN}): ${err}`);
      }
    }

    // 对/错都持久化判题结果（best-effort，失败不阻断判题返回）
    try {
      await this.practiceResultsRepo.upsert({
        student_id: input.studentId,
        subject_id: input.subjectId,
        card_id: input.cardId,
        lesson_id: input.lessonId,
        question_id: questionId,
        question_n: input.questionN,
        question_text: input.questionText,
        student_answer: input.studentAnswer,
        is_correct: isCorrect,
        method,
        analysis,
        error_type: errorType,
      });
    } catch (err) {
      this.logger.error(`practiceResultsRepo.upsert failed (student=${input.studentId}, card=${input.cardId}, qn=${input.questionN}): ${err}`);
    }

    return { questionId, isCorrect, method, analysis, errorType, errorBookId };
  }

  /** 取该学生在该卡的持久化判题结果（is_correct TINYINT -> boolean）。 */
  async getResults(studentId: number, cardId: number): Promise<PracticeResultDto[]> {
    const rows = await this.practiceResultsRepo.findByStudentCard(studentId, cardId);
    return rows.map((r) => ({
      questionN: r.question_n,
      questionText: r.question_text,
      studentAnswer: r.student_answer,
      isCorrect: !!r.is_correct,
      method: r.method,
      analysis: r.analysis,
      errorType: r.error_type,
    }));
  }

  /** 兜底卡题号正则（与前端 CourseDetailPage.tsx 的 EXERCISE_ITEM_RE 保持一致）。 */
  private static readonly FALLBACK_ITEM_RE = /^\(?([1-9]\d?)[.)]/;

  /**
   * 解析一张练习卡的应答题号集合。必须与前端 CourseDetailPage.tsx 的复合键规则一致：
   * - 结构化卡（content_metadata.groups 非空）：groups[gi].questions[].n -> `${gi}-${n}`
   * - 兜底卡（needs_fallback 或无 groups）：对 content 按题号正则提取 -> `0-${n}`（n 从 1 递增）
   * 解析不出任何题号（无可作答项）时返回空数组，调用方跳过该卡不拦截。
   */
  private extractPracticeQuestionNs(card: { content: string; metadata: unknown }): string[] {
    const md = card.metadata as
      | { groups?: Array<{ questions: Array<{ n: number }> }>; needs_fallback?: boolean }
      | null;
    if (md?.groups?.length) {
      const qns: string[] = [];
      md.groups.forEach((g, gi) => g.questions.forEach(q => qns.push(`${gi}-${q.n}`)));
      return qns;
    }
    // 兜底：近似前端 preprocessContent（NFKC 归一 + 分段）后按题号正则提取
    const qns: string[] = [];
    let n = 1;
    let found = false;
    for (const line of String(card.content ?? '')
      .normalize('NFKC')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)) {
      if (PracticeService.FALLBACK_ITEM_RE.test(line)) {
        qns.push(`0-${n++}`);
        found = true;
      } else if (!found) {
        continue;
      }
    }
    return qns;
  }

  /**
   * 课程完成门禁：该课全部练习卡的题目是否都已作答（practice_results 覆盖）。
   * 无练习卡直接返回 true；解析不到题号的练习卡（无可作答项）跳过不拦截。
   * 供 ProgressService.updateProgress 在完成课程（advanceLesson）前兜底校验。
   */
  async isLessonPracticeComplete(studentId: number, lessonId: number): Promise<boolean> {
    const { cards } = await this.contentService.getLessonCards(lessonId);
    const practiceCards = cards.filter(c => c.cardType === 'practice');
    if (practiceCards.length === 0) return true;

    const rows = await this.practiceResultsRepo.findByStudentLesson(studentId, lessonId);
    const answeredByCard = new Map<number, Set<string>>();
    for (const r of rows) {
      let set = answeredByCard.get(r.card_id);
      if (!set) {
        set = new Set();
        answeredByCard.set(r.card_id, set);
      }
      set.add(r.question_n);
    }

    for (const card of practiceCards) {
      const questionNs = this.extractPracticeQuestionNs(card);
      if (questionNs.length === 0) continue;
      const answered = answeredByCard.get(card.id) ?? new Set<string>();
      if (!questionNs.every(qn => answered.has(qn))) return false;
    }
    return true;
  }

  /** 单卡 reset：删除该学生该卡的全部判题结果（不动 main_error_books）。 */
  async resetCard(studentId: number, cardId: number): Promise<void> {
    await this.practiceResultsRepo.deleteByStudentCard(studentId, cardId);
  }

  /** 课程级 reset：删除该学生该课全部卡片的判题结果（不动 main_error_books）。 */
  async resetLesson(studentId: number, lessonId: number): Promise<void> {
    await this.practiceResultsRepo.deleteByStudentLesson(studentId, lessonId);
  }

  /**
   * 查询学生某学科所有未清零的课堂练习错题详情（用于「错题清零」门禁）。
   * 以 main_error_books（source='practice' + is_cleared=0）为唯一真相源，
   * LEFT JOIN questions 补全题面--不再依赖 practice_results，避免两表数据不一致时漏检。
   * 进每节课前清空错题本里的 practice 未清题（兜住历史/跳过/写入失败的错题）。
   *
   * 课时范围（2026-09-01 修正）：传 currentLessonId 时只返回「当前课之前」的错题
   * （lesson_id < currentLessonId，星图同款 id 数值序）；本课练习刚产生的错题不触发
   * 清零阶段（刷新本课不弹出「错题清零」），留待进入下一课时再清。
   * 不传 currentLessonId 时不过滤课时（兼容旧行为/无课时上下文的调用方）。
   * lesson_id 为 null 的孤儿历史行无法归课，保守保留。
   *
   * 版本隔离：按 progress.textbook_version_id（家长配置/学习固化的当前教材版本）过滤，
   * 家长切换教材后旧版错题保留在库但不再出现在门禁/列表。无 progress 记录时不过滤（兜底全量）。
   *
   * 去重：同一 (cardId, question_n) 可能因并发判题或题面变体产生多条记录，
   * 只保留最早一条；答对时 clearUnclearedByStudentQuestion 会清掉同 question_id 的所有行，
   * 题面变体导致不同 question_id 的重复行在后续清零轮次逐步消除。
   */
  async getUnclearedErrorDetails(
    studentId: number,
    subjectId: number,
    currentLessonId?: number | null,
  ): Promise<{
    errors: Array<{
      errorBookId: number;
      cardId: number;
      questionN: string;
      questionText: string;
      questionId: number | null;
      /** 卡片所属课的 lesson_id（cards.lesson_id，可能为 null：历史行 source_ref_id 无对应卡时）。 */
      lessonId: number | null;
    }>;
  }> {
    const progress = await this.progressRepo.findByStudentAndSubject(studentId, subjectId);
    const rows = await this.mainErrorRepo.findUnclearedPracticeByStudentSubject(
      studentId,
      subjectId,
      progress?.textbookVersionId ?? null,
    );
    const seen = new Set<string>();
    const errors: Array<{
      errorBookId: number;
      cardId: number;
      questionN: string;
      questionText: string;
      questionId: number | null;
      lessonId: number | null;
    }> = [];
    for (const r of rows) {
      // 「错题清零」门禁只清当前课之前产生的错题：本课（及后续课）练习刚产生的
      // 错题不得触发清零阶段，留待进入下一课时再清。lesson_id 与星图同用
      // id 数值序（db_loader 按书序插入，id 随教学顺序单调递增）；
      // lesson_id 为 null 的孤儿历史行无法归课，保守保留（兜住历史数据）。
      if (currentLessonId != null && r.lesson_id != null && r.lesson_id >= currentLessonId) {
        continue;
      }
      const cardId = r.source_ref_id ?? 0;
      // question_n 缺失（历史行未回填）时合成唯一键，保证清零可用
      const questionN = r.question_n ?? `cleanup-${r.id}`;
      const key = `${cardId}-${questionN}`;
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push({
        errorBookId: r.id,
        cardId,
        questionN,
        questionText: r.questionText ?? '',
        questionId: r.question_id,
        lessonId: r.lesson_id,
      });
    }
    return { errors };
  }

  /**
   * 批量递增错题严重程度（level + 1）。
   * 用于清零后仍有错误的题。
   */
  async bumpErrorLevels(errorBookIds: number[]): Promise<void> {
    await this.mainErrorRepo.bumpLevels(errorBookIds);
  }

  /**
   * 课堂练习「提示」：先查 cards.hints 缓存（命中直返，省 AI），未命中则调
   * HintCapability 生成苏格拉底式提示（不给答案）并写回 cards.hints，供后续复用。
   * 缓存是 Card 级共享（不分学生）：同一题对所有人都用同一提示。
   * AI 生成失败 -> 抛 503（code 5001），前端降级显示静态文案，不阻断答题。
   */
  async getHint(input: HintInput): Promise<HintOutput> {
    // 1. 查缓存（key = 题目文本）
    const hintsRaw = await this.cardsRepo.findHintsById(input.cardId);
    if (hintsRaw) {
      try {
        const hintsObj = JSON.parse(hintsRaw) as Record<string, string>;
        const cached = hintsObj[input.questionText];
        if (cached) {
          return { hint: cached, cached: true };
        }
      } catch {
        // 损坏 JSON：忽略缓存，走生成路径（upsertHint 会覆写）
      }
    }

    // 2. 未命中 -> AI 生成
    try {
      const result = await this.hint.generate({
        questionContent: input.questionText,
        subject: 'math',
      });
      // 3. 写回缓存（失败不阻断返回，仅记日志）
      try {
        await this.cardsRepo.upsertHint(input.cardId, input.questionText, result.content);
      } catch (err) {
        this.logger.error(`upsertHint failed (cardId=${input.cardId}): ${err}`);
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

  /**
   * 课堂练习「让 AI 讲一讲」：打开讨论即
   *   ① 记入主线错题本（find-or-create 幂等，source='discuss'）；
   *   ② 创建带 card_id 的 mainline 对话并返回 dialogueId。
   * 前端拿到 dialogueId 后走 /api/ai/tutor/stream（mode=mainline）做苏格拉底讨论，
   * TutoringCapability 据 card_id 解析 cardContent 限定范围。
   *
   * questionId 解析用 content_hash 快查（不调 AI 结构化，避免开抽屉等待）；
   * 未命中则 question_id=null + wrong_answer_text 存题面（与判题 quality=poor 路径一致）。
   * 错题本记录无论后续答对答错都保留（清除门禁尚未实现，markCleared 暂无调用方）。
   */
  async startDiscuss(input: DiscussInput): Promise<DiscussOutput> {
    // ① 解析 questionId（快查 content_hash，未命中 null）
    const contentHash = computeContentHash(input.questionText);
    const q: QuestionRow | null = await this.questionsRepo.findByContentHash(contentHash);
    const questionId: number | null = q?.id ?? null;

    // ② 错题本 find-or-create（幂等）
    const existing = await this.mainErrorRepo.findUnclearedByStudentQuestion(
      input.studentId,
      questionId,
      input.cardId,
      input.questionText,
    );
    let errorBookId: number;
    if (existing) {
      errorBookId = existing.id;
    } else {
      errorBookId = await this.mainErrorRepo.create({
        student_id: input.studentId,
        subject_id: input.subjectId,
        question_id: questionId,
        source: 'discuss',
        source_ref_id: input.cardId,
        question_n: null,
        lesson_id: input.lessonId,
        wrong_answer_text: questionId === null ? input.questionText : null,
      });
    }

    // ③ B方案：对话也 find-or-create。错题本是「学生+题」的锚：
    //    - 已绑 dialogue_id 且对话仍可用 -> 复用（跨刷新/跨设备续接同一讨论线）；
    //    - 否则 -> 新建 mainline 对话并回写 dialogue_id。
    //    TutoringCapability 据 card_id 解析 cardContent 限定范围。
    const dialogueId = await this.resolveDiscussDialogue(input, existing?.dialogue_id ?? null, errorBookId);

    return { dialogueId, errorBookId, questionId };
  }

  /**
   * B方案核心：复用错题本上已绑的 dialogue_id；不可用则新建并回写。
   * 抽出以便 startDiscuss 主流程清晰。
   */
  private async resolveDiscussDialogue(
    input: DiscussInput,
    boundDialogueId: number | null,
    errorBookId: number,
  ): Promise<string> {
    if (boundDialogueId) {
      try {
        // 校验归属 + 对话仍存在（deleted_at 已过滤）。命中则复用，不另起对话。
        await this.conversationsService.get(boundDialogueId, input.studentId);
        return String(boundDialogueId);
      } catch {
        // 对话已删/不可达 -> 落到新建分支，重建并回写。
      }
    }
    const dialogue = await this.conversationsService.create(input.studentId, {
      track: 'mainline',
      cardId: input.cardId,
    });
    if (!dialogue) {
      throw new HttpException(
        { code: 5000, message: '创建讨论会话失败' },
        500,
      );
    }
    await this.mainErrorRepo.updateDialogueId(errorBookId, dialogue.id);
    return String(dialogue.id);
  }

  /**
   * 卡片级「思辨答疑」：find-or-create 该学生在该卡片的 mainline 对话。
   * 与题目级两点不同：scope=整张卡片（非某题）；**不入错题本**（讨论知识非题目），
   * 故以 (student, card_id) 为锚而非 error_book.dialogue_id。重开回到同一对话。
   */
  async startCardDiscuss(input: DiscussCardInput): Promise<DiscussCardOutput> {
    const dialogue = await this.conversationsService.findOrCreateMainlineByCard(
      input.studentId,
      input.cardId,
      input.subjectId,
    );
    return { dialogueId: String(dialogue.id) };
  }
}
