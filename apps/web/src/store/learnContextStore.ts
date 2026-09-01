import { create } from 'zustand';

/** 当前学习上下文（星图数据加载后写入，供 StudentLayout 顶栏展示真实 学科·年级·版本）。 */
interface LearnContextState {
  subjectName: string | null;
  gradeName: string | null;
  publisher: string | null;
  setContext: (ctx: { subjectName: string | null; gradeName: string | null; publisher: string | null }) => void;
}

export const useLearnContextStore = create<LearnContextState>((set) => ({
  subjectName: null,
  gradeName: null,
  publisher: null,
  setContext: (ctx) => set(ctx),
}));
