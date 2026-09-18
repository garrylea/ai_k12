import { NavLink } from 'react-router-dom';

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
 */
const navItems = [
  { to: '/student/star-map', label: '星图导航' },
  { to: '/student/error-book', label: '错题本' },
  { to: '/student/rewards', label: '奖励册' },
  { to: '/student/profile', label: '个人中心' },
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
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-button)] transition-all text-sm
              ${
                isActive
                  ? 'bg-[var(--brand-100)] text-[var(--brand-600)] font-semibold'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]'
              }`
            }
          >
            <span className="hidden lg:inline">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* 底部 */}
      <div className="px-4 py-4 border-t border-[var(--bg-subtle)]">
        <div className="hidden lg:flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
          <span>三年级 · 数学</span>
        </div>
      </div>
    </aside>
  );
}
