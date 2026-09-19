import type { ReactNode } from 'react';

/**
 * 侧栏导航图标的统一外壳（`style.md` §2：图标仅限功能图标、必须是线性 SVG、禁用 emoji）。
 *
 * ⚠️ 这些图标**不是装饰**，是窄屏下的唯一可辨识信息：两端侧栏在 `<lg`（<1024px）都收成
 * 64px 图标栏，标签是 `hidden lg:inline`。**补图标之前，那一栏是整列空白**——家长在窄窗口下
 * 找不到「目标设定」（2026-09-20 用户实际走查发现），学生端同样问题。
 * 所以删改导航项时必须同时给它一个图标，别再出现「只有文字、没有图标」的项。
 *
 * 取色用 `currentColor`（跟随 NavLink 的 active/hover 文字色），不传颜色字面量。
 */
export function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5 shrink-0"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
