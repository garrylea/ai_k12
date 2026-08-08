import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';
import { listAllConversations } from '@/services/api';
import { relativeTime, stripTitleDate } from '@/utils/time';

export default function ConversationList() {
  const { conversations, setConversations, currentDialogueId, setCurrentDialogueId } = useAuxiliaryStore();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConversations = () => {
    setLoading(true);
    setError(null);
    listAllConversations('auxiliary')
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

  // Sidebar = quick-switch of the 7 most recent. The full list (search /
  // rename / delete) lives on the dedicated 会话管理 page.
  const MAX_VISIBLE = 7;
  const visible = conversations.slice(0, MAX_VISIBLE);
  const hasMore = conversations.length > MAX_VISIBLE;

  return (
    <div className="flex-1 flex flex-col p-4 min-h-0">
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-[#86868B]">
          加载中...
        </div>
      ) : error ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <p className="text-sm text-[#86868B]">{error}</p>
          <button
            onClick={fetchConversations}
            className="px-4 py-2 rounded-lg text-sm bg-[#FF6B00] text-white hover:opacity-90 transition"
          >
            重试
          </button>
        </div>
      ) : conversations.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-[#86868B]">
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
                className={`w-full text-left px-3 py-2 rounded-xl text-sm transition ${
                  currentDialogueId === c.id
                    ? 'bg-[#F9F9FB] text-[#1D1D1F] font-medium'
                    : 'text-[#86868B] hover:bg-[#F9F9FB] hover:text-[#1D1D1F]'
                }`}
              >
                <span className="block truncate">{stripTitleDate(c.title) || '未命名会话'}</span>
                <span className="block text-xs text-[#A0A0A5] mt-0.5">
                  {relativeTime(c.created_at)}
                </span>
              </button>
            ))}
          </div>
          {hasMore && (
            <button
              onClick={() => navigate('/student/auxiliary/conversations')}
              className="text-sm text-[#FF6B00] mt-2 hover:underline"
            >
              全部展开
            </button>
          )}
        </>
      )}
    </div>
  );
}
