import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { LogoutButton } from '@/components/base';

/**
 * 线性 SVG 图标的统一外壳（`style.md` §2：图标仅限功能图标、必须是线性 SVG、禁用 emoji）。
 *
 * ⚠️ 这些图标**不是装饰**，是窄屏下的唯一可辨识信息：侧栏在 `<lg` 时收成 64px 图标栏，
 * 标签是 `hidden lg:inline`。**在补图标之前，这一栏在窄屏下是 10 行空白**——家长根本看不出
 * 哪行是哪个入口（2026-09-20 用户实际走查时因此找不到「目标设定」）。
 * 所以删改导航项时必须同时给它一个图标，别再出现「只有文字、没有图标」的项。
 */
function Icon({ children }: { children: ReactNode }) {
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

const navItems: Array<{ to: string; label: string; icon: ReactNode }> = [
  {
    to: '/parent/messages',
    label: '消息',
    icon: <Icon><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z" /></Icon>,
  },
  {
    to: '/parent/students',
    label: '学生账号',
    icon: (
      <Icon>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20a6 6 0 0 1 12 0" />
        <path d="M17 11a3 3 0 1 0-2.5-4.7" />
        <path d="M21 20a5 5 0 0 0-4-4.9" />
      </Icon>
    ),
  },
  {
    to: '/parent/dashboard',
    label: '仪表盘',
    icon: (
      <Icon>
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </Icon>
    ),
  },
  {
    to: '/parent/report',
    label: '学情报告',
    icon: (
      <Icon>
        <line x1="6" y1="20" x2="6" y2="12" />
        <line x1="12" y1="20" x2="12" y2="5" />
        <line x1="18" y1="20" x2="18" y2="9" />
      </Icon>
    ),
  },
  {
    to: '/parent/errors',
    label: '错题查看',
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="9" />
        <path d="M9 9l6 6M15 9l-6 6" />
      </Icon>
    ),
  },
  {
    to: '/parent/chat-logs',
    label: 'AI 对话回放',
    icon: (
      <Icon>
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v5h5" />
      </Icon>
    ),
  },
  {
    to: '/parent/goals',
    label: '目标设定',
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1" />
      </Icon>
    ),
  },
  {
    to: '/parent/controls',
    label: '行为管控',
    icon: (
      <Icon>
        <line x1="4" y1="7" x2="20" y2="7" />
        <circle cx="9" cy="7" r="2" />
        <line x1="4" y1="17" x2="20" y2="17" />
        <circle cx="15" cy="17" r="2" />
      </Icon>
    ),
  },
  {
    to: '/parent/rewards',
    label: '奖励管理',
    icon: (
      <Icon>
        <rect x="3" y="8" width="18" height="4" rx="1" />
        <path d="M5 12v8h14v-8" />
        <path d="M12 8v12" />
      </Icon>
    ),
  },
  {
    to: '/parent/account',
    label: '账号设置',
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="10" r="3" />
        <path d="M6.5 19a6 6 0 0 1 11 0" />
      </Icon>
    ),
  },
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
            // 窄屏（<lg）标签被 CSS 隐藏，靠 title 悬停提示 + aria-label 让入口仍可辨识
            title={item.label}
            aria-label={item.label}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm
              ${
                isActive
                  ? 'bg-blue-50 text-[#2563EB] font-semibold'
                  : 'text-[#4B5563] hover:bg-gray-50 hover:text-[#1F2937]'
              }`
            }
          >
            {item.icon}
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
