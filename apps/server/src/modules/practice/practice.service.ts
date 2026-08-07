import { Injectable } from '@nestjs/common';
import { QuestionsRepository, MainErrorBooksRepository } from '../../database/repositories/index.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';
import { JudgmentCapability } from '../../ai-core/capabilities/judgment.capability.js';
import { computeContentHash } from '../error-book/content-hash.util.js';
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
      if (picked) return !!picked.isCorrect;
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
      const result = await this.judgment.judge({
        questionContent: input.questionText,
        standardAnswer: q?.answer ?? '',
        reference: q?.explanation ?? '',
        studentAnswer: input.studentAnswer,
        subject: 'math',
        questionType,
      });
      isCorrect = result.isCorrect;
      method = 'ai';
      analysis = isCorrect ? null : result.analysis;
      errorType = result.errorType ?? null;
    }

    let questionId: number | null = q?.id ?? null;
    let errorBookId: number | undefined;

    // 路由 3：答错 -> 入主线错题本（未入库的题先结构化 + 插题）
    if (!isCorrect) {
      if (!q) {
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
        } else {
          questionId = null;
        }
      }
      errorBookId = await this.mainErrorRepo.create({
        student_id: input.studentId,
        subject_id: input.subjectId,
        question_id: questionId,
        source: 'practice',
        source_ref_id: input.cardId,
        wrong_answer_text: questionId === null ? input.questionText : null,
      });
    }

    return { questionId, isCorrect, method, analysis, errorType, errorBookId };
  }
}
