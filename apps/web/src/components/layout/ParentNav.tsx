import { NavLink } from 'react-router-dom';
import { LogoutButton } from '@/components/base';

const navItems = [
  { to: '/parent/messages', label: '消息' },
  { to: '/parent/students', label: '学生账号' },
  { to: '/parent/dashboard', label: '仪表盘' },
  { to: '/parent/report', label: '学情报告' },
  { to: '/parent/errors', label: '错题查看' },
  { to: '/parent/chat-logs', label: 'AI 对话回放' },
  { to: '/parent/goals', label: '目标设定' },
  { to: '/parent/controls', label: '行为管控' },
  { to: '/parent/rewards', label: '奖励管理' },
  { to: '/parent/account', label: '账号设置' },
];

export function ParentNav() {
  const stored = localStorage.getItem('username') ?? '';
  // 家长存的是手机号，打码展示；异常情况下兜底显示"家长"
  const phone = /^1\d{10}$/.test(stored) ? `${stored.slice(0, 3)}****${stored.slice(7)}` : '';

  return (
    <aside className="w-16 lg:w-56 shrink-0 bg-white border-r border-gray-200 flex flex-col transition-all">
      <div className="flex items-center gap-3 px-4 h-16 border-b border-gray-200">
        <div className="w-9 h-9 rounded-lg bg-[#2563EB] flex items-center justify-center text-white font-bold">
          K
        </div>
        <span className="hidden lg:inline text-lg font-bold text-[#1F2937]">家长管理台</span>
      </div>

      <nav className="flex-1 py-4 space-y-1 px-2">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm
              ${
                isActive
                  ? 'bg-blue-50 text-[#2563EB] font-semibold'
                  : 'text-[#4B5563] hover:bg-gray-50 hover:text-[#1F2937]'
              }`
            }
          >
            <span className="hidden lg:inline">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* 用户信息卡：与学生端左侧栏底部一致（头像 + 账号 + 退出按钮） */}
      <div className="p-3">
        <div className="flex items-center justify-between p-2.5 rounded-xl bg-blue-50/60 border border-blue-100">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-full bg-[#2563EB] flex items-center justify-center text-white font-bold shrink-0">
              家
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-[#1F2937] truncate">{phone || '家长'}</div>
              <div className="text-xs text-[#6B7280]">家长账号</div>
            </div>
          </div>
          <LogoutButton className="!p-2 border-blue-100 hover:bg-blue-100/60" />
        </div>
      </div>
    </aside>
  );
}
