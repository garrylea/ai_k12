import { Injectable, Logger, HttpException } from '@nestjs/common';
import { QuestionsRepository, MainErrorBooksRepository, CardsRepository } from '../../database/repositories/index.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';
import { JudgmentCapability } from '../../ai-core/capabilities/judgment.capability.js';
import { HintCapability } from '../../ai-core/capabilities/hint.capability.js';
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
  // TODO: lessonId 当前未用于入库（main_error_books 无 lesson_id 列），
  // 后续若需按课时统计错题，可在此接入。
  lessonId: number;
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

    // 路由 3：答错 -> 入主线错题本（未入库的题先结构化 + 插题）
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
      // Important #2: 孤儿题补偿 -- mainErrorRepo.create 失败时若刚创建了题，
      // 删除孤儿题再抛（镜像 ErrorBookService.insertQuestionAndAux）。
      try {
        errorBookId = await this.mainErrorRepo.create({
          student_id: input.studentId,
          subject_id: input.subjectId,
          question_id: questionId,
          source: 'practice',
          source_ref_id: input.cardId,
          wrong_answer_text: questionId === null ? input.questionText : null,
        });
      } catch (err) {
        if (questionCreated && questionId !== null) {
          await this.questionsRepo.deleteById(questionId).catch(() => {});
        }
        throw err;
      }
    }

    return { questionId, isCorrect, method, analysis, errorType, errorBookId };
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
}
