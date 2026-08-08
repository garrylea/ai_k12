import { create } from 'zustand';
import type { JudgeResult } from '../services/api';

interface AnswerRecord extends JudgeResult {
  studentAnswer: string;
}

interface PracticeState {
  cardId: number | null;
  questions: { n: string; text: string }[];
  answers: Record<string, AnswerRecord>;
  currentIndex: number;
  setSession: (cardId: number, questions: { n: string; text: string }[]) => void;
  record: (n: string, studentAnswer: string, result: JudgeResult) => void;
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
