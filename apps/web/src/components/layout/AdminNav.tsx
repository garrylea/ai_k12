import { NavLink } from 'react-router-dom';
import { LogoutButton } from '@/components/base';

const navItems = [
  { to: '/admin', label: '总览', end: true },
  { to: '/admin/models', label: '模型配置' },
  { to: '/admin/accounts', label: '账号管理' },
  { to: '/admin/messages', label: '消息推送' },
  { to: '/admin/chat', label: 'AI 助手' },
  { to: '/admin/security', label: '账号安全' },
];

export function AdminNav() {
  return (
    <aside className="w-16 lg:w-56 shrink-0 bg-white border-r border-gray-200 flex flex-col transition-all">
      <div className="flex items-center gap-3 px-4 h-16 border-b border-gray-200">
        <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center text-white font-bold">K</div>
        <span className="hidden lg:inline text-lg font-bold text-slate-900">管理员中枢</span>
      </div>
      <nav className="flex-1 py-4 space-y-1 px-2">
        {navItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end}
            className={({ isActive }) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm ${isActive ? 'bg-blue-50 text-blue-600 font-semibold' : 'text-slate-600 hover:bg-gray-50'}`}>
            <span className="hidden lg:inline">{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="p-3">
        <div className="flex items-center justify-between p-2.5 rounded-xl bg-blue-50/60 border border-blue-100">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-full bg-slate-800 flex items-center justify-center text-white font-bold shrink-0">管</div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 truncate">管理员</div>
              <div className="text-xs text-slate-500">管理台</div>
            </div>
          </div>
          <LogoutButton className="!p-2 border-blue-100 hover:bg-blue-100/60" />
        </div>
      </div>
    </aside>
  );
}
