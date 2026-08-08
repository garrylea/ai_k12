import { create } from 'zustand';
import type { JudgeResult } from '../services/api';

interface AnswerRecord extends JudgeResult {
  studentAnswer: string;
}

interface PracticeState {
  cardId: number | null;
  questions: { n: number; text: string }[];
  // 按 question.text 索引：同一卡内 n 会跨大题重置（1,2,3,4,1,2,3），不能用 n 做 key
  answers: Record<string, AnswerRecord>;
  currentIndex: number;
  setSession: (cardId: number, questions: { n: number; text: string }[]) => void;
  record: (questionText: string, studentAnswer: string, result: JudgeResult) => void;
  reset: () => void;
}

export const usePracticeStore = create<PracticeState>((set) => ({
  cardId: null,
  questions: [],
  answers: {},
  currentIndex: 0,
  setSession: (cardId, questions) => set({ cardId, questions, answers: {}, currentIndex: 0 }),
  record: (questionText, studentAnswer, result) =>
    set((s) => ({ answers: { ...s.answers, [questionText]: { ...result, studentAnswer } } })),
  reset: () => set({ cardId: null, questions: [], answers: {}, currentIndex: 0 }),
}));
