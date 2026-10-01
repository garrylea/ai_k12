import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/base';
import { ackBillingNotice, listUnreadBillingNotices, type BillingNoticeView } from '@/services/api';

/** 与 AlertBanner 同口径：数据源本身低频，30s 足够。 */
export const NOTICE_POLL_INTERVAL_MS = 30_000;

/**
 * 家长顶栏「裁决结果条」（批④补丁 spec §3.1）：独立组件，与预警（孩子行为）、
 * 订阅状态（付费状态）不合并。首拉失败 → 隐藏（后续轮询周期重试）；
 * 已展示后再失败 → 保留现有列表。逐条「知道了」ack，全空不渲染。
 */
export default function BillingNoticeBar() {
  const [notices, setNotices] = useState<BillingNoticeView[] | null>(null);

  const load = useCallback(() => {
    listUnreadBillingNotices()
      .then((res) => setNotices(res.items))
      .catch(() => {
        /* 首拉失败保持 null（隐藏）；已展示时保留现有列表 */
      });
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, NOTICE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const ack = (id: number) => {
    ackBillingNotice(id)
      .then(() => setNotices((prev) => prev?.filter((n) => n.id !== id) ?? prev))
      .catch(() => toast('error', '操作失败，请稍后再试'));
  };

  if (!notices || notices.length === 0) return null;

  return (
    <div data-testid="billing-notice-bar" className="space-y-2 px-6 pt-3">
      {notices.map((n) => (
        <div
          key={n.id}
          className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] bg-white px-4 py-2.5"
        >
          <div className="min-w-0 text-sm">
            {n.type === 'claim_approved' ? (
              <span className="font-medium text-[var(--success)]">您的订阅已开通</span>
            ) : (
              <span className="font-medium text-[var(--error)]">
                管理员未确认本次转账{n.reason ? `：${n.reason}` : ''}
              </span>
            )}
          </div>
          <button
            type="button"
            data-testid={`billing-notice-ack-${n.id}`}
            onClick={() => ack(n.id)}
            className="shrink-0 rounded-md border border-[var(--bg-subtle)] px-3 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
          >
            知道了
          </button>
        </div>
      ))}
    </div>
  );
}
