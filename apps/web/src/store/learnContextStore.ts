import { create } from 'zustand';

/**
 * 当前学习上下文（星图数据加载后写入，供 StudentLayout 顶栏展示真实 学科·年级·版本）。
 *
 * `subjectId` 是**数字**学科 id：顶栏只显示名字就够，但埋点上报 `study_sessions.subject_id`
 * 需要数字（后端要校验它属于在售学科，并按它做「各科学了多久」的聚合）。
 * 它不在路由 state 里取——路由 state 只有在「从星图进入」时才带，直接刷新/深链会丢。
 */
interface LearnContextState {
  subjectId: number | null;
  subjectName: string | null;
  gradeName: string | null;
  publisher: string | null;
  setContext: (ctx: {
    subjectId: number | null;
    subjectName: string | null;
    gradeName: string | null;
    publisher: string | null;
  }) => void;
}

export const useLearnContextStore = create<LearnContextState>((set) => ({
  subjectId: null,
  subjectName: null,
  gradeName: null,
  publisher: null,
  setContext: (ctx) => set(ctx),
}));
