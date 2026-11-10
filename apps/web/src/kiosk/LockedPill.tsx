import { formatRemaining } from './learningLock';

/**
 * 锁定中的剩余时间提示（spec 2026-11-10 §2）。
 *
 * **不再常驻**：由 `LockedPillReveal` 控制可见性（进入浅停留页 3 秒 / 顶边悬停 / 点击 5 秒）。
 * 放在**顶栏下方 8px**（`top-[72px]`）：顶栏高 64px，胶囊若贴 `top-3` 会整块压住
 * 个人中心/奖励册/练习记录三个 tab（2026-11-10 用户实测，学生点不到练习记录）。
 * `pointer-events-none` 是硬要求：它只是展示，任何点击都要落到下面。
 */
export function LockedPill({ remainingMs, visible }: { remainingMs: number; visible: boolean }) {
  return (
    <div
      data-testid="locked-pill"
      data-visible={visible ? 'true' : 'false'}
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
      className={`fixed left-1/2 top-[72px] z-40 -translate-x-1/2 rounded-full border border-[var(--brand-500)] bg-[var(--brand-100)] px-4 py-1.5 text-sm font-medium text-[var(--brand-600)] shadow-sm pointer-events-none transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {formatRemaining(remainingMs)} · 本次学习时长未满，需家长解除后才能退出
    </div>
  );
}
