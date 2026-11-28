import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LogoutButton } from '@/components/base';
import { getResearchFeaturedPendingCount } from '@/services/api';
import { FEATURED_SETS_CHANGED } from '@/pages/research/ResearchFeaturedSetsPage';

const navItems = [
  { to: '/research/papers', label: '试卷管理' },
  { to: '/research/featured-sets', label: '精选题单' },
  { to: '/research/audit', label: '审计日志' },
];

/** 教研空间侧栏：试卷管理 / 精选题单（待审核角标）/ 审计日志 / 退出。 */
export function ResearchNav() {
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const load = () => getResearchFeaturedPendingCount()
      .then((r) => setPending(r.count))
      .catch(() => {});
    load();
    window.addEventListener('focus', load);
    // 页面内审核动作成功后主动通知角标重拉（角标不在页面上，不能靠路由重挂载）
    window.addEventListener(FEATURED_SETS_CHANGED, load);
    return () => {
      window.removeEventListener('focus', load);
      window.removeEventListener(FEATURED_SETS_CHANGED, load);
    };
  }, []);

  return (
    <aside className="w-16 lg:w-56 shrink-0 bg-white border-r border-gray-200 flex flex-col transition-all">
      <div className="flex items-center gap-3 px-4 h-16 border-b border-gray-200">
        <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center text-white font-bold">研</div>
        <span className="hidden lg:inline text-lg font-bold text-slate-900">教研空间</span>
      </div>
      <nav className="flex-1 py-4 space-y-1 px-2">
        {navItems.map((item) => (
          <NavLink key={item.to} to={item.to}
            className={({ isActive }) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm ${isActive ? 'bg-blue-50 text-blue-600 font-semibold' : 'text-slate-600 hover:bg-gray-50'}`}>
            <span className="hidden lg:inline">{item.label}</span>
            {item.to === '/research/featured-sets' && pending > 0 && (
              <span
                data-testid="featured-pending-badge"
                className="hidden lg:inline-flex ml-auto min-w-[20px] h-5 px-1.5 items-center justify-center rounded-full bg-[var(--error)] text-white text-xs font-bold"
              >
                {pending > 99 ? '99+' : pending}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="p-3">
        <div className="flex items-center justify-between p-2.5 rounded-xl bg-blue-50/60 border border-blue-100">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-full bg-slate-800 flex items-center justify-center text-white font-bold shrink-0">研</div>
            <div className="min-w-0 hidden lg:block">
              <div className="text-sm font-medium text-slate-900 truncate">教研员</div>
              <div className="text-xs text-slate-500">教研空间</div>
            </div>
          </div>
          <LogoutButton className="!p-2 border-blue-100 hover:bg-blue-100/60" />
        </div>
      </div>
    </aside>
  );
}
