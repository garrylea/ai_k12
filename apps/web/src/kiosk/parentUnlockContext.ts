import { createContext, useContext } from 'react';

/**
 * 家长是否**主动**点过【解除锁定】（`unlocked_at` 非空）。
 *
 * 与 `LearningLockContext` 分开的原因：那个 context 只在「锁定中」才非 null，
 * 而「已解除」恰好意味着不锁 —— 塞进去就要放宽给值条件，会让
 * `LearningSessionShell.test.tsx` 里 5 条「未锁定时 lock-probe 为 none」的断言失效。
 *
 * 真源仍是 `LearningSessionShell`（它持有轮询回来的 `lock`），本文件只承载下发通道。
 */
export const ParentUnlockContext = createContext<boolean>(false);

export function useParentUnlocked(): boolean {
  return useContext(ParentUnlockContext);
}
