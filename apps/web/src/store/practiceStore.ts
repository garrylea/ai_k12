import { create } from 'zustand';
import type { JudgeResult } from '../services/api';

interface AnswerRecord extends JudgeResult {
  studentAnswer: string;
  /** 判定失败（超时/服务异常）的前端标记，非后端返回 */
  failed?: boolean;
}

interface PracticeState {
  cardId: number | null;
  questions: { n: string; text: string }[];
  answers: Record<string, AnswerRecord>;
  /** 提示缓存（key = 复合题号 q.n，如 "0-1"）：session 内避免重复请求后端 */
  hints: Record<string, string>;
  /** 讨论对话缓存（key = 题目文本 -> dialogueId）：session 内重开抽屉可续接同一对话 */
  discussDialogues: Record<string, string>;
  currentIndex: number;
  setSession: (cardId: number, questions: { n: string; text: string }[]) => void;
  record: (n: string, studentAnswer: string, result: JudgeResult, opts?: { failed?: boolean }) => void;
  setHint: (n: string, hint: string) => void;
  setDiscussDialogue: (questionText: string, dialogueId: string) => void;
  reset: () => void;
}

export const usePracticeStore = create<PracticeState>((set) => ({
  cardId: null,
  questions: [],
  answers: {},
  hints: {},
  discussDialogues: {},
  currentIndex: 0,
  setSession: (cardId, questions) => set({ cardId, questions, answers: {}, hints: {}, discussDialogues: {}, currentIndex: 0 }),
  record: (n, studentAnswer, result, opts) =>
    set((s) => ({ answers: { ...s.answers, [n]: { ...result, studentAnswer, failed: opts?.failed } } })),
  setHint: (n, hint) => set((s) => ({ hints: { ...s.hints, [n]: hint } })),
  setDiscussDialogue: (questionText, dialogueId) =>
    set((s) => ({ discussDialogues: { ...s.discussDialogues, [questionText]: dialogueId } })),
  reset: () => set({ cardId: null, questions: [], answers: {}, hints: {}, discussDialogues: {}, currentIndex: 0 }),
}));
