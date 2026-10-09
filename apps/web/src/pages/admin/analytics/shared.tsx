import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

/**
 * 埋点 Phase 2 分析页共享件（8 个分析子页全用它，Task 15/16 填实各页 body）。
 *
 * 样式纪律：文本色全走 token（var(--text-primary) / var(--text-secondary)），
 * 页头模式照 AdminAlertsPage 的 header 写法；无 emoji。
 */

const TABS = [
  { to: '/admin/analytics', label: '总览' },
  { to: '/admin/analytics/funnel', label: '漏斗' },
  { to: '/admin/analytics/retention', label: '留存' },
  { to: '/admin/analytics/modules', label: '模块' },
  { to: '/admin/analytics/devices', label: '设备' },
  { to: '/admin/analytics/quality', label: '质量' },
  { to: '/admin/analytics/llm-tokens', label: 'Token' },
  { to: '/admin/analytics/events', label: '事件流' },
];

export interface AnalyticsWindow {
  from: string;
  to: string;
}

function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 分析页日期窗 state（YYYY-MM-DD，默认今天-6 到今天 = 近 7 天）。
 * from/to 各自独立 set，页面把整窗传给 AnalyticsPageShell 的 onWindowChange。
 */
export function useAdminAnalyticsWindow(): {
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
} {
  const now = new Date();
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 6);
  const [from, setFrom] = useState(toDateString(weekAgo));
  const [to, setTo] = useState(toDateString(now));
  return { from, to, setFrom, setTo };
}

export function AnalyticsPageShell(props: {
  title: string;
  description: string;
  window: AnalyticsWindow;
  onWindowChange: (w: AnalyticsWindow) => void;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>{props.title}</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{props.description}</p>
      </div>
      <nav aria-label="分析子页" className="flex gap-1 border-b border-gray-200 overflow-x-auto">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.to === '/admin/analytics'}
            className={({ isActive }) =>
              `px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-all ${
                isActive
                  ? 'border-blue-600 text-blue-600 font-semibold'
                  : 'border-transparent hover:bg-gray-50'
              }`
            }
            style={({ isActive }) => (isActive ? undefined : { color: 'var(--text-secondary)' })}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div data-testid="date-range" className="flex items-center gap-2">
        <input
          type="date"
          aria-label="开始日期"
          value={props.window.from}
          onChange={(e) => props.onWindowChange({ ...props.window, from: e.target.value })}
          className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm"
          style={{ color: 'var(--text-primary)' }}
        />
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>至</span>
        <input
          type="date"
          aria-label="结束日期"
          value={props.window.to}
          onChange={(e) => props.onWindowChange({ ...props.window, to: e.target.value })}
          className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm"
          style={{ color: 'var(--text-primary)' }}
        />
      </div>
      {props.children}
    </div>
  );
}

/** 百分比格式化：null（量不到/无数据）→ '—'，数值按百分比四舍五入。 */
export const fmtPct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);

/** 秒 → 'X 小时 Y 分'（<60s 显示秒）；null → '—'。 */
export const fmtDuration = (sec: number | null) =>
  sec == null ? '—' : sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 3600)} 小时 ${Math.round((sec % 3600) / 60)} 分`;
