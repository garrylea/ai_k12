import { create } from 'zustand';
import type { JudgeResult, PracticeResult } from '../services/api';

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
  loadResults: (cardId: number, questions: { n: string; text: string }[], results: PracticeResult[]) => void;
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
  loadResults: (cardId, questions, results) => set((s) => {
    const dbAnswers: Record<string, AnswerRecord> = {};
    for (const r of results) {
      dbAnswers[r.questionN] = {
        questionId: null,
        isCorrect: r.isCorrect,
        method: r.method,
        analysis: r.analysis,
        errorType: r.errorType ?? null,
        studentAnswer: r.studentAnswer,
      };
    }
    // 同卡重入（effect 在用户作答后才返回）：保留在途作答（current 优先），DB 仅填补空缺
    const merged = s.cardId === cardId ? { ...dbAnswers, ...s.answers } : dbAnswers;
    return {
      cardId,
      questions,
      answers: merged,
      hints: s.cardId === cardId ? s.hints : {},
      discussDialogues: s.cardId === cardId ? s.discussDialogues : {},
      currentIndex: 0,
    };
  }),
  record: (n, studentAnswer, result, opts) =>
    set((s) => ({ answers: { ...s.answers, [n]: { ...result, studentAnswer, failed: opts?.failed } } })),
  setHint: (n, hint) => set((s) => ({ hints: { ...s.hints, [n]: hint } })),
  setDiscussDialogue: (questionText, dialogueId) =>
    set((s) => ({ discussDialogues: { ...s.discussDialogues, [questionText]: dialogueId } })),
  reset: () => set({ cardId: null, questions: [], answers: {}, hints: {}, discussDialogues: {}, currentIndex: 0 }),
}));
