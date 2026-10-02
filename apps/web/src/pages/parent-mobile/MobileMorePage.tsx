import { Link, useParams } from 'react-router-dom';

/** v1 只做入口列表；不在名单里的功能一律引导回电脑端（spec §3）。 */
export const MOBILE_MORE_ITEMS = [
  { key: 'subscription', label: '订阅管理' },
  { key: 'points', label: '积分与兑换' },
  { key: 'report', label: '学习报告' },
  { key: 'chat-logs', label: 'AI 对话记录' },
  { key: 'goals', label: '学习目标' },
  { key: 'messages', label: '消息中心' },
  { key: 'students', label: '学生管理' },
  { key: 'account', label: '账号设置' },
] as const;

export default function MobileMorePage() {
  const { name } = useParams();
  if (name) {
    const item = MOBILE_MORE_ITEMS.find((i) => i.key === name);
    return (
      <div data-testid="mobile-page-stub" className="rounded-2xl bg-white p-8 text-center">
        <p className="text-lg font-bold">{item?.label ?? '该功能'}</p>
        <p className="mt-2 text-[var(--text-secondary)]">该功能请在电脑端使用</p>
      </div>
    );
  }
  return (
    <div data-testid="mobile-page-more" className="divide-y divide-black/5 rounded-2xl bg-white">
      {MOBILE_MORE_ITEMS.map((i) => (
        <Link key={i.key} to={`/m/parent/more/${i.key}`} className="block px-5 py-4">
          {i.label}
        </Link>
      ))}
    </div>
  );
}
