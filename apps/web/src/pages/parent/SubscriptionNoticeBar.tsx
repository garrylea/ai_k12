import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSubscriptionStatus, type SubscriptionStatusView } from '@/services/api';

/**
 * 家长端顶栏订阅提示条（订阅批③ Task 4）：
 * 只表达**付费状态**，与 AlertBanner（孩子行为预警）是两个独立组件——
 * 在 ParentLayout 里并列渲染，不许合并成「同一组件的两种文案」。
 *
 * 惰性口径：挂载时拉一次订阅状态，不做轮询（家长切页/支付返回后重挂自然刷新）；
 * 拉取失败静默不渲染——提示条永不阻断家长端。
 *
 * 三态：expired → 红「订阅已过期，学生端已锁定，请续费」；
 * daysRemaining <= 7 且非 expired → 黄「订阅即将到期，剩余 N 天」；其余不渲染。
 * 点击整条进订阅中心 /parent/subscription。
 */
export default function SubscriptionNoticeBar() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<SubscriptionStatusView | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSubscriptionStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        /* 拉取失败静默：提示条永不阻断家长端 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  const expired = status.status === 'expired';
  const expiring = !expired && status.daysRemaining <= 7;
  if (!expired && !expiring) return null;

  return (
    <button
      type="button"
      data-testid="subscription-notice-bar"
      onClick={() => navigate('/parent/subscription')}
      className={`w-full px-6 py-2.5 flex items-center justify-center gap-1.5 text-sm font-semibold shrink-0 transition-opacity hover:opacity-90 ${
        expired ? 'bg-[var(--error)] text-white' : 'bg-[var(--warning)] text-white'
      }`}
    >
      <span>
        {expired
          ? '订阅已过期，学生端已锁定，请续费'
          : `订阅即将到期，剩余 ${status.daysRemaining} 天`}
      </span>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-4 h-4 shrink-0"
        aria-hidden="true"
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
  );
}
