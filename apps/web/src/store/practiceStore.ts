import { create } from 'zustand';
import type { JudgeResult } from '../services/api';

interface AnswerRecord extends JudgeResult {
  studentAnswer: string;
}

interface PracticeState {
  cardId: number | null;
  questions: { n: number; text: string }[];
  answers: Record<number, AnswerRecord>;
  currentIndex: number;
  setSession: (cardId: number, questions: { n: number; text: string }[]) => void;
  record: (n: number, studentAnswer: string, result: JudgeResult) => void;
  reset: () => void;
}

export const usePracticeStore = create<PracticeState>((set) => ({
  cardId: null,
  questions: [],
  answers: {},
  currentIndex: 0,
  setSession: (cardId, questions) => set({ cardId, questions, answers: {}, currentIndex: 0 }),
  record: (n, studentAnswer, result) =>
    set((s) => ({ answers: { ...s.answers, [n]: { ...result, studentAnswer } } })),
  reset: () => set({ cardId: null, questions: [], answers: {}, currentIndex: 0 }),
}));
