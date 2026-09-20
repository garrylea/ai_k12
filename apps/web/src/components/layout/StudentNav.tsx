import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { NavIcon } from '@/components/base';

/**
 * 主轨侧边二级导航。
 *
 * 组成与顺序依据 `docs/UX-UI设计文档.md` §3.3「学生端导航（主轨/辅轨物理隔离）」：
 * 主轨侧边 = 星图导航 / 主线错题本 / 奖励册 / 学情报告 / 个人中心，**不含辅轨入口**。
 *
 * ⚠️ 两条勿再添加的项（2026-09-18 按用户裁决删除）：
 * - **辅线**（`/student/auxiliary`）：文档明写「不含辅轨入口」，且 CLAUDE.md 硬规则要求
 *   双轨「物理隔离靠路由（入口选择页，无跨轨链接）」。在这里放一个辅线入口就是跨轨链接。
 *   辅线只能从入口选择页（`/student/entry`）进。
 * - **主线**（`/student/mainline`）：它只是 `Navigate to="/student/star-map"`，与「星图导航」
 *   指向同一页；UX §3.3 的清单里也没有单独的「主线」项。
 *
 * 待补：文档清单里的「学情报告」目前既无导航项也无路由（P2.8 未实现）。
 *
 * ⚠️ 2026-09-18 起，「奖励册/个人中心」已改用浅停留页外壳（`StudentStayLayout`，
 * 无侧栏），所以这两项**当前只会在还挂在 `StudentLayout` 下的 P2.4–P2.8 占位页上
 * 渲染**。保留它们（文档清单要求），但别为了「点得到」把侧栏塞回浅停留页。
 *
 * 底部原有一行硬编码「三年级 · 数学」假数据，已删 —— 真实年级/学科由
 * `StudentLayout` 顶栏从 `learnContextStore` 显示。
 */
const navItems: Array<{ to: string; label: string; icon: ReactNode }> = [
  {
    to: '/student/star-map',
    label: '星图导航',
    icon: (
      <NavIcon>
        <circle cx="12" cy="12" r="9" />
        <path d="M15.5 8.5l-2 5-5 2 2-5z" />
      </NavIcon>
    ),
  },
  {
    to: '/student/error-book',
    label: '错题本',
    icon: (
      <NavIcon>
        <path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" />
        <path d="M9.5 9l4 4M13.5 9l-4 4" />
      </NavIcon>
    ),
  },
  {
    to: '/student/rewards',
    label: '奖励册',
    icon: (
      <NavIcon>
        <circle cx="12" cy="9" r="5" />
        <path d="M8.5 13.5L7 21l5-3 5 3-1.5-7.5" />
      </NavIcon>
    ),
  },
  {
    to: '/student/profile',
    label: '个人中心',
    icon: (
      <NavIcon>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="10" r="3" />
        <path d="M6.5 19a6 6 0 0 1 11 0" />
      </NavIcon>
    ),
  },
];

export function StudentNav() {
  return (
    <aside className="w-16 lg:w-56 shrink-0 bg-[var(--bg-card)] border-r border-[var(--bg-subtle)] flex flex-col transition-all">
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 h-16 border-b border-[var(--bg-subtle)]">
        <div className="w-9 h-9 rounded-[var(--radius-button)] bg-[var(--brand-500)] flex items-center justify-center text-white font-bold">
          K
        </div>
        <span className="hidden lg:inline text-lg font-bold text-[var(--text-primary)]">
          智学
        </span>
      </div>

      {/* 导航项 */}
      <nav className="flex-1 py-4 space-y-1 px-2">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            // 窄屏（<lg）标签被 CSS 隐藏，靠 title 悬停提示 + aria-label 让入口仍可辨识
            title={item.label}
            aria-label={item.label}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-button)] transition-all text-sm
              ${
                isActive
                  ? 'bg-[var(--brand-100)] text-[var(--brand-600)] font-semibold'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]'
              }`
            }
          >
            {item.icon}
            <span className="hidden lg:inline">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
