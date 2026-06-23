import { NavLink } from 'react-router-dom';

const navItems = [
  { to: '/student/star-map', label: '星图导航' },
  { to: '/student/mainline', label: '主线' },
  { to: '/student/auxiliary', label: '辅线' },
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
