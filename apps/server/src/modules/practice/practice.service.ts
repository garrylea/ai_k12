import { Injectable, Logger, HttpException } from '@nestjs/common';
import { QuestionsRepository, MainErrorBooksRepository } from '../../database/repositories/index.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';
import { JudgmentCapability } from '../../ai-core/capabilities/judgment.capability.js';
import { computeContentHash } from '../../common/utils/content-hash.util.js';
import type { QuestionRow } from '../../database/repositories/types.js';

/** 客观题类型集合：命中题库时走 exact 比对，不调 AI。 */
const OBJECTIVE_TYPES = new Set(['choice', 'true_false', 'fill_blank']);

/** 答案归一：NFKC 全半角归一 + 去空白 + 去 $ + 转小写。 */
function normalizeAnswer(s: string): string {
  return (s || '').normalize('NFKC').replace(/\s+/g, '').replace(/\$+/g, '').toLowerCase();
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

@Injectable()
export class PracticeService {
  private readonly logger = new Logger(PracticeService.name);

  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly structuring: QuestionStructuringCapability,
    private readonly judgment: JudgmentCapability,
  ) {}

  async judge(input: JudgeInput): Promise<JudgeOutput> {
    const contentHash = computeContentHash(input.questionText);
    const q: QuestionRow | null = await this.questionsRepo.findByContentHash(contentHash);

    let isCorrect: boolean;
    let method: 'exact' | 'ai';
    let analysis: string | null = null;
    let errorType: 'logic' | 'calculation' | 'format' | 'missing' | null = null;

    if (q && OBJECTIVE_TYPES.has(q.type)) {
      // 路由 1：题库命中 + 客观题 -> exact 比对
      isCorrect = compareAnswer(input.studentAnswer, q.answer, q.options);
      method = 'exact';
      analysis = isCorrect ? null : `正确答案：${q.answer}`;
    } else {
      // 路由 2：题库命中 short_answer/proof 或未命中 -> AI 判定
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
}
