import { useEffect, useState } from 'react';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';
import { listConversations } from '@/services/api';

export default function ConversationList() {
  const { conversations, setConversations, currentDialogueId, setCurrentDialogueId } = useAuxiliaryStore();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConversations = () => {
    setLoading(true);
    setError(null);
    listConversations('auxiliary')
      .then((items) => {
        setConversations(items);
        setLoading(false);
      })
      .catch(() => {
        setError('会话列表加载失败');
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setConversations]);

  const visible = expanded ? conversations : conversations.slice(0, 10);

  return (
    <div className="flex-1 flex flex-col p-4 min-h-0">
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-secondary)]">
          加载中...
        </div>
      ) : error ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <p className="text-sm text-[var(--text-secondary)]">{error}</p>
          <button
            onClick={fetchConversations}
            className="px-4 py-2 rounded-lg text-sm bg-[var(--brand-500)] text-white"
          >
            重试
          </button>
        </div>
      ) : conversations.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-secondary)]">
          暂无历史会话
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-auto space-y-2 min-h-0">
            {visible.map((c) => (
              <button
                key={c.id}
                onClick={() => setCurrentDialogueId(c.id)}
                aria-pressed={currentDialogueId === c.id}
                className={`w-full text-left px-3 py-2 rounded-xl text-sm ${
                  currentDialogueId === c.id
                    ? 'bg-[var(--brand-500)]/10 text-[var(--brand-500)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]'
                }`}
              >
                {c.title ?? '未命名会话'}
              </button>
            ))}
          </div>
          {conversations.length > 10 && (
            <button
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              className="text-sm text-[var(--brand-500)] mt-2"
            >
              {expanded ? '收起' : '展开全部'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
