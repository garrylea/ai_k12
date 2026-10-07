import { useCallback, useEffect, useState } from 'react';
import {
  getUnreadMessageCount, listMyMessages, markMessageRead, type ParentMessageItem,
} from '@/services/api';

/**
 * /m/parent/messages 消息中心（Task 2）。
 *
 * `data-testid="mobile-page-messages"` 被 Task 2 路由测试消费，参考 MobileDashboardPage
 * 的做法：testid 挂在**所有状态共用的外层容器**上，不只在数据就绪分支。
 * 条目点击展开正文，展开即调 markMessageRead；失败静默（条目保留，下次进页以服务端为准）。
 * 30s 未读轮询的定时器在本页自建（不与桌面共享），失败静默、不清空已展示列表。
 * 三条通知条在 MobileParentLayout 外壳里，本页不重复渲染。
 */
export default function MobileMessagesPage() {
  const [messages, setMessages] = useState<ParentMessageItem[] | null>(null);
  const [error, setError] = useState(false);
  const [unread, setUnread] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(() => {
    setError(false);
    listMyMessages()
      .then((list) => { setMessages(list); })
      .catch(() => setError(true));
  }, []);

  useEffect(() => { load(); }, [load]);
  // 未读数自轮询（30s，语义与桌面一致；本页自建定时器实例）
  useEffect(() => {
    const tick = () => getUnreadMessageCount().then(setUnread).catch(() => {});
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const expand = (m: ParentMessageItem) => {
    setExpandedId(expandedId === m.id ? null : m.id);
    if (!m.isRead) {
      markMessageRead(m.id)
        .then(() => setMessages((prev) => prev?.map((x) => (x.id === m.id ? { ...x, isRead: true } : x)) ?? prev))
        .catch(() => { /* 已读失败静默：条目保留，下次进页以服务端为准 */ });
    }
  };

  return (
    <div data-testid="mobile-page-messages" className="space-y-3">
      {unread !== null && <p className="rounded-2xl bg-white px-4 py-3 text-sm">{unread} 条未读</p>}
      {error ? (
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="messages-retry" onClick={load} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      ) : messages === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      ) : messages.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-[var(--text-secondary)]">暂无消息</p>
      ) : (
        <ul className="space-y-2">
          {messages.map((m) => (
            <li key={m.id}>
              <button
                data-testid={`msg-item-${m.id}`}
                onClick={() => expand(m)}
                className="w-full rounded-2xl bg-white p-4 text-left"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold">{m.title}</span>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    {m.isBroadcast ? '广播 · ' : ''}{m.isRead ? '已读' : '未读'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  {new Date(m.createdAt).toLocaleString('zh-CN')}
                </p>
                {expandedId === m.id && (
                  <p className="mt-2 border-t border-[var(--bg-subtle)] pt-2 text-sm">{m.content}</p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
