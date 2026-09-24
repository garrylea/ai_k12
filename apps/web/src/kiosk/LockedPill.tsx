import { formatRemaining } from './learningLock';

/**
 * 锁定中的剩余时间提示（spec §6.4）。
 *
 * **为什么要它**：仓库纪律「界面优先于文字提示」——剩余时间要被**看到**，
 * 而不是只在学生点了登出、被拒绝时才解释。学生知道还有多久，就不会去试各种逃逸路径。
 *
 * 定位用 fixed + 顶部居中：沉浸页自己的顶栏在右上角已经有 `LogoutButton`，
 * 贴右上会撞在一起。**人工冒烟时确认它与各页顶栏不重叠**；若重叠，这是纯展示层调整，
 * 改 className 即可，不要动状态机。
 */
export function LockedPill({ remainingMs }: { remainingMs: number }) {
  return (
    <div
      data-testid="locked-pill"
      role="status"
      aria-live="polite"
      className="fixed left-1/2 top-3 z-50 -translate-x-1/2 rounded-full border border-[var(--brand-500)] bg-[var(--brand-100)] px-4 py-1.5 text-sm font-medium text-[var(--brand-600)] shadow-sm"
    >
      {formatRemaining(remainingMs)} · 本次学习时长未满，需家长解除后才能退出
    </div>
  );
}
