import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/base';
import {
  getUnreadMessageCount, getParentAlerts, markParentAlertRead,
  type ParentAlertItem,
} from '@/services/api';

const POLL_INTERVAL_MS = 30_000;
const PAGE_SIZE = 20;

/**
 * /m/parent/alerts 预警列表（Task 6）。
 *
 * `data-testid="mobile-page-alerts"` 被 Task 2 路由测试消费，参考 MobileDashboardPage
 * 的做法：testid 挂在**所有状态共用的外层容器**上，不只在数据就绪分支。
 * 30s 未读轮询的定时器在本页自建（不与桌面共享），失败静默、不清空已展示列表。
 * 裁决 / 订阅条在 MobileParentLayout 外壳里，本页不重复渲染。
 */
export default function MobileAlertsPage() {
  const [items, setItems] = useState<ParentAlertItem[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState(false);
  const [unreadMessages, setUnreadMessages] = useState<number | null>(null);

  const load = useCallback((p: number) => {
    setError(false);
    getParentAlerts({ page: p, pageSize: PAGE_SIZE })
      .then((res) => { setItems(res.items); setTotal(res.total); setPage(res.page); })
      .catch(() => setError(true));
  }, []);

  useEffect(() => { load(1); }, [load]);
  useEffect(() => {
    const tick = () => getUnreadMessageCount().then(setUnreadMessages).catch(() => {});
    tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const ack = (id: number) => {
    markParentAlertRead(id)
      .then(() => setItems((prev) => prev?.filter((a) => a.id !== id) ?? prev))
      // 失败不静默：条目留在列表里（isRead 未变），但家长得知道操作没成功
      .catch(() => toast('error', '操作失败，请稍后再试'));
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (error) {
    return (
      <div data-testid="mobile-page-alerts">
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="alerts-retry" onClick={() => load(page)} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="mobile-page-alerts" className="space-y-3">
      {unreadMessages !== null && (
        <p className="rounded-2xl bg-white px-4 py-3 text-sm">{unreadMessages} 条未读消息</p>
      )}
      {items === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      ) : items.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-[var(--text-secondary)]">暂无预警</p>
      ) : (
        <ul className="space-y-2">
          {items.map((a) => (
            <li key={a.id} className="rounded-2xl bg-white p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-bold">{a.message}</p>
                  <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                    {a.studentName ?? '未知学生'} · {a.level} · {new Date(a.createdAt).toLocaleString('zh-CN')}
                  </p>
                </div>
                {!a.isRead && (
                  <button data-testid={`alert-ack-${a.id}`} onClick={() => ack(a.id)} className="shrink-0 text-sm text-[var(--brand-500)]">
                    知道了
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between px-2 text-sm">
        <button data-testid="alerts-prev" disabled={page <= 1} onClick={() => load(page - 1)} className="disabled:opacity-30">上一页</button>
        <span>{page} / {totalPages}</span>
        <button data-testid="alerts-next" disabled={page >= totalPages} onClick={() => load(page + 1)} className="disabled:opacity-30">下一页</button>
      </div>
    </div>
  );
}
