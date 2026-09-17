import type { MeaningJudgeResult } from '@/services/api';

/** 学生一句的完整作答。结果栈要留着它——答完就推进下一句，输入框已经不在了。 */
export interface MeaningAnswerPayload {
  terms: Array<{ term: string; answer: string }>;
  meaning: string;
  emotion: string;
}

/**
 * 结果栈里的一条。新项一律 **unshift 进数组头部** —— 最新的一条排在最前。
 *   pending —— 已提交、等模型回来（页面显示「判定中…」）
 *   failed  —— 请求失败，可重试
 *   judged  —— 有结果
 */
export type StackItem =
  | { kind: 'pending'; key: string; sentenceIndex: number; text: string; answer: MeaningAnswerPayload }
  | { kind: 'failed';  key: string; sentenceIndex: number; text: string; answer: MeaningAnswerPayload }
  | { kind: 'judged';  key: string; sentenceIndex: number; text: string; answer: MeaningAnswerPayload; result: MeaningJudgeResult };
