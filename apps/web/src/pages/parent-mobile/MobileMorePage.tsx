import { Link, useParams } from 'react-router-dom';

/** 2A 起拆两组：live = 已上手机的真实入口；stub = 仍指向电脑端（订阅等用户裁决延后）。 */
export const MOBILE_LIVE_ITEMS = [
  { key: 'students', label: '学生管理', to: '/m/parent/students' },
  { key: 'messages', label: '消息中心', to: '/m/parent/messages' },
  { key: 'goals', label: '学习目标', to: '/m/parent/goals' },
  { key: 'account', label: '账号设置', to: '/m/parent/account' },
] as const;

export const MOBILE_STUB_ITEMS = [
  { key: 'subscription', label: '订阅管理' },
  { key: 'points', label: '积分与兑换' },
  { key: 'report', label: '学习报告' },
  { key: 'chat-logs', label: 'AI 对话记录' },
] as const;

export default function MobileMorePage() {
  const { name } = useParams();
  if (name) {
    const stub = MOBILE_STUB_ITEMS.find((i) => i.key === name);
    return (
      <div data-testid="mobile-page-stub" className="rounded-2xl bg-white p-8 text-center">
        <p className="text-lg font-bold">{stub?.label ?? '该功能'}</p>
        <p className="mt-2 text-[var(--text-secondary)]">该功能请在电脑端使用</p>
      </div>
    );
  }
  return (
    <div data-testid="mobile-page-more" className="space-y-3">
      <div className="divide-y divide-[var(--bg-subtle)] rounded-2xl bg-white">
        {MOBILE_LIVE_ITEMS.map((i) => (
          <Link key={i.key} to={i.to} data-testid={`more-live-${i.key}`} className="block px-5 py-4">
            {i.label}
          </Link>
        ))}
      </div>
      <div className="divide-y divide-[var(--bg-subtle)] rounded-2xl bg-white">
        {MOBILE_STUB_ITEMS.map((i) => (
          <Link key={i.key} to={`/m/parent/more/${i.key}`} data-testid={`more-stub-${i.key}`} className="block px-5 py-4 text-[var(--text-secondary)]">
            {i.label}
            <span className="ml-2 text-xs text-[var(--text-tertiary)]">电脑端</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
