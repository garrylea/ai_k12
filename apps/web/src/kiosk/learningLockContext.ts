import { createContext, useContext } from 'react';

/**
 * 学习锁定态的唯一真源在 `LearningSessionShell`（轮询 + 本地快照都在那里）。
 * 只有浅停留页需要"剩余时间"展示，所以用 context 下发，**不要**在页面里再读一次
 * localStorage —— 那会出现第二份真源，切换学生/解锁时必然漂移。
 */
export interface LearningLockValue {
  locked: boolean;
  /** 剩余毫秒（已由 provider 每秒刷新）。 */
  remainingMs: number;
}

export const LearningLockContext = createContext<LearningLockValue | null>(null);

export function useLearningLock(): LearningLockValue | null {
  return useContext(LearningLockContext);
}
