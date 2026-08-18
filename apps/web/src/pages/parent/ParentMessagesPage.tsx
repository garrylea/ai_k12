import { useEffect, useState } from 'react';
import { listMyMessages, markMessageRead, type ParentMessageItem } from '@/services/api';
import { toast } from '@/components/base';

type MessageType = 'promo' | 'learning' | 'system';

const TYPE_LABELS: Record<MessageType, string> = {
  promo: '优惠',
  learning: '学情',
  system: '系统公告',
};

const TYPE_STYLES: Record<MessageType, { color: string; bg: string }> = {
  promo: { color: '#1D4ED8', bg: 'rgba(29,78,216,0.08)' },
  learning: { color: '#047857', bg: 'rgba(4,120,87,0.08)' },
  system: { color: 'var(--text-secondary)', bg: 'rgba(0,0,0,0.04)' },
};

export default function ParentMessagesPage() {
  const [messages, setMessages] = useState<ParentMessageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setMessages(await listMyMessages());
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleToggle = async (m: ParentMessageItem) => {
    if (expandedId === m.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(m.id);
    if (!m.isRead) {
      try {
        await markMessageRead(m.id);
        setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, isRead: true } : x)));
      } catch (err: unknown) {
        toast('error', err instanceof Error ? err.message : '标记已读失败');
      }
    }
  };

  const typeTag = (t: string) => {
    const key: MessageType =
      t === 'promo' || t === 'learning' || t === 'system' ? t : 'system';
    const s = TYPE_STYLES[key];
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold"
        style={{ color: s.color, backgroundColor: s.bg }}
      >
        {TYPE_LABELS[key]}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>
          消息中心
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          平台推送的通知消息，点击查看详情。
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        {messages.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
            {loading ? '加载中...' : '暂无消息'}
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {messages.map((m) => (
              <div key={m.id}>
                <button
                  type="button"
                  className="w-full text-left px-5 py-4 flex items-center gap-3 hover:bg-[var(--bg-subtle)] transition-colors"
                  onClick={() => handleToggle(m)}
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${m.isRead ? 'bg-transparent' : 'bg-[#2563EB]'}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div
                      className={`text-sm truncate ${
                        m.isRead
                          ? 'font-normal text-[var(--text-secondary)]'
                          : 'font-bold text-[var(--text-primary)]'
                      }`}
                    >
                      {m.title}
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                      {new Date(m.createdAt).toLocaleString('zh-CN')}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {m.isBroadcast && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-600">
                        平台公告
                      </span>
                    )}
                    {typeTag(m.type)}
                  </div>
                </button>
                {expandedId === m.id && (
                  <div
                    className="px-5 pb-4 pl-10 text-sm leading-relaxed whitespace-pre-line"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {m.content}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
