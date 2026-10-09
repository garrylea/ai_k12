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

/**
 * 秒 → 'X 小时 Y 分'（<60s 显示秒；不足 1 小时只显示'Y 分'）；null → '—'。
 * 分取 floor 不取 round：3599s 必须是 '59 分'，round 会进位成 '0 小时 60 分'（T14 评审裁定）。
 */
export const fmtDuration = (sec: number | null) => {
  if (sec == null) return '—';
  if (sec < 60) return `${sec} 秒`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
};

/**
 * 事件/模块英文名 → 中文展示名。事件 17 项 = 服务端 events.service `EVENT_TIER` 字典
 * （母 spec §5.2）；模块 8 项 = 服务端 ops-analytics.service `FUNNEL_STEPS` 白名单
 * （delta spec §7.1）。漏斗/模块表/下拉的展示统一走 `eventLabel`，未登记 key 原样显示。
 */
export const EVENT_LABELS: Record<string, string> = {
  // 事件（17）
  study_session_started: '进入学习',
  study_session_ended: '结束学习',
  study_session_idle: '学习走神',
  page_view: '页面浏览',
  answer_submitted: '提交作答',
  hint_requested: '请求提示',
  answer_revealed: '查看答案',
  self_assess_answered: '提交自评',
  consecutive_failures: '连续答错',
  card_flipped: '翻卡',
  ai_message_sent: 'AI 提问',
  error_book_added: '加入错题本',
  error_book_cleared: '错题清零',
  points_awarded: '获得积分',
  exam_submitted: '交卷',
  special_unit_judged: '专项判题',
  llm_fallback_triggered: '模型降级',
  // 模块（8，漏斗白名单）
  mainline: '主线',
  exam: '考试',
  training_targeted: '专项练习',
  training_error_practice: '错题练习',
  chinese_dictation: '语文默写',
  chinese_interpretation: '语文理解',
  chinese_meaning: '古诗含义',
  en_vocabulary: '背单词',
};

/** 英文名 → 中文展示名；字典外 key 原样返回（后端新增事件不至显示成空）。 */
export const eventLabel = (key: string): string => EVENT_LABELS[key] ?? key;

/** 漏斗模块下拉的 8 个白名单值（与服务端 FUNNEL_STEPS 同源，delta spec §7.1）。 */
export const FUNNEL_MODULES = [
  'mainline',
  'exam',
  'training_targeted',
  'training_error_practice',
  'chinese_dictation',
  'chinese_interpretation',
  'chinese_meaning',
  'en_vocabulary',
] as const;
