import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { usePointsStore } from '@/store/pointsStore';
import type { PointsToastItem } from '@/store/pointsStore';
import { useThemeStore } from '@/store/themeStore';

/** 自动消失时长（含无动效时——无动效只是不做过渡，不是立刻闪没）。 */
const AUTO_DISMISS_MS = 2500;

/**
 * 系统级降级：用户在操作系统里关了动效就不再做位移/淡入。
 * 用 `typeof` 双保险——jsdom 与部分老旧 WebView 没有 `matchMedia`。
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** 加分：圆 + 加号 */
function CoinPlusIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  );
}

/** 已达上限：圆 + 表针（中性，不是错误） */
function LimitClockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

function PointsToastCard({ item, animate }: { item: PointsToastItem; animate: boolean }) {
  const dismiss = usePointsStore((s) => s.dismiss);
  // 关动效时初始即「已进入」：第一帧就是可见的，不靠 effect 追一帧
  const [entered, setEntered] = useState(!animate);

  useEffect(() => {
    setEntered(true);
  }, []);

  // 每条**各自**计时：多条排队时互不影响，先来的先走
  useEffect(() => {
    const timer = setTimeout(() => dismiss(item.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [dismiss, item.id]);

  // `<= 0` 而非 `=== 0`：轻反馈只承载「加分」，非正数一律走中性文案，
  // 结构上保证永远不会渲染出 `+-5 分` 这种负数文案（计划 §2.2「不显示负数」）。
  const atLimit = item.points <= 0;

  return (
    <div
      data-testid="points-toast"
      style={{
        opacity: entered ? 1 : 0,
        transform: entered ? 'none' : 'translateY(8px)',
        transition: animate
          ? 'opacity 200ms var(--motion-ease), transform 200ms var(--motion-ease)'
          : undefined,
      }}
      className={clsx(
        // 有意**不加** `pointer-events-auto`：外层容器是 `pointer-events-none`，
        // 卡片没有点击行为，却会盖在答题控件上 2.5s——恢复指针事件等于白白吞掉
        // 这些点击（计划 §1.2#5「积分反馈不能遮挡或抢注意力于答题控件」）。
        'flex items-center gap-3',
        'min-w-[13rem] max-w-[20rem] px-4 py-3',
        'rounded-[var(--radius-card)] shadow-[var(--shadow-elevated)]',
        // 加分态只用浅品牌底 + 阴影（不加高饱和描边，别抢答题控件的注意力）；
        // 上限态是白卡 + 细边框的中性提示——**不是错误**。
        // 注意：Tailwind 3.4 对 `var()` 颜色**不支持** `/25` 这类透明度修饰符
        // （`border-[var(--brand-500)]/25` 会静默不生成任何 CSS），只能用整色。
        atLimit
          ? 'bg-[var(--bg-elevated)] border border-[var(--bg-subtle)]'
          : 'bg-[var(--brand-100)]',
      )}
    >
      {atLimit ? (
        <LimitClockIcon className="shrink-0 text-[var(--text-tertiary)]" />
      ) : (
        <CoinPlusIcon className="shrink-0 text-[var(--brand-600)]" />
      )}
      <div className="min-w-0">
        <div className="truncate text-[var(--fs-caption)] text-[var(--text-secondary)]">{item.title}</div>
        <div
          className={clsx(
            'text-[var(--fs-body)] font-semibold',
            // 已达上限是中性提示，不用 error 色（不是失败）
            atLimit ? 'text-[var(--text-secondary)]' : 'text-[var(--brand-600)]',
          )}
        >
          {atLimit ? '今日该任务积分已达上限' : `+${item.points} 分`}
        </div>
      </div>
    </div>
  );
}

/**
 * 积分轻反馈（右下角，多条纵向排队）。
 *
 * 挂在 `App.tsx` 根上而不是任何 Layout 内：训练轨的答题页（专项 / 背单词 / 语文 / 考试）
 * 都是全屏页、不在任何 Layout 下，挂进外壳里永远看不到发分反馈。
 *
 * `z-40` 有意低于答题弹窗的 `z-50`：绝不能盖住「提示 / 讨论 / 提交」，
 * 也不能抢苏格拉底按钮的注意力（`docs/superpowers/plans/2026-09-17-gamification-points-student-ui.md` §1.2）。
 */
export function PointsToast() {
  const queue = usePointsStore((s) => s.queue);
  const motionEnabled = useThemeStore((s) => s.motionEnabled);
  const animate = motionEnabled && !prefersReducedMotion();

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2"
      aria-live="polite"
    >
      {queue.map((item) => (
        <PointsToastCard key={item.id} item={item} animate={animate} />
      ))}
    </div>
  );
}
