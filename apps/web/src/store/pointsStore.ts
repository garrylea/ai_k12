import { create } from 'zustand';

/**
 * 一条积分轻反馈。
 *
 * `points === 0` 是**正常结果**（幂等命中 / 今日该任务已达上限），不是错误——
 * 文案由 `PointsToast` 按这个值分支，不要在这里改成正数或负数。
 */
export interface PointsToastItem {
  id: string;
  points: number;
  /** 如「英语背单词 · 10 词」 */
  title: string;
  /** 晋升段位（code 字符串）。**本 store 只承载、不消费**：全屏庆祝归 `CelebrationOverlay`，
   *  轻反馈这里不弹晋升，避免同一件事两处同时弹。 */
  levelUp?: { from: string; to: string } | null;
}

interface PointsState {
  queue: PointsToastItem[];
  push: (item: Omit<PointsToastItem, 'id'>) => void;
  dismiss: (id: string) => void;
}

/** 单调递增，保证同一次会话里 id 唯一（`Date.now()` 在同一毫秒内可能撞号）。 */
let seq = 0;

/**
 * 积分轻反馈队列（右下角浮出）。
 *
 * 有意**不在这里起定时器**：销毁逻辑属于展示层（`PointsToast` 的 effect），
 * 这样队列本身是纯粹的数据结构，测试不必等时间、卸载时也不会留定时器。
 */
export const usePointsStore = create<PointsState>((set) => ({
  queue: [],
  push: (item) => set((s) => ({ queue: [...s.queue, { ...item, id: `pt-${++seq}` }] })),
  dismiss: (id) => set((s) => ({ queue: s.queue.filter((t) => t.id !== id) })),
}));
