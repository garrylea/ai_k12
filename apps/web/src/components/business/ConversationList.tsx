import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';
import { listConversations } from '@/services/api';

export default function ConversationList() {
  const { conversations, setConversations, currentDialogueId, setCurrentDialogueId } = useAuxiliaryStore();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    listConversations('auxiliary')
      .then((items) => setConversations(items))
      .catch(() => {
        // API unavailable; leave conversations as empty list
      });
  }, [setConversations]);

  const visible = expanded ? conversations : conversations.slice(0, 10);

  return (
    <div className="flex-1 flex flex-col p-4">
      <h2 className="text-lg font-bold text-[var(--text-primary)] mb-3">历史答疑</h2>
      <div className="flex-1 overflow-auto space-y-2">
        {visible.map((c) => (
          <button
            key={c.id}
            onClick={() => setCurrentDialogueId(c.id)}
            className={`w-full text-left px-3 py-2 rounded-xl text-sm ${
              currentDialogueId === c.id
                ? 'bg-[#8B5A8E]/10 text-[#8B5A8E]'
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
          className="text-sm text-[#8B5A8E] mt-2"
        >
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
      <Link
        to="/student/error-book"
        className="mt-4 block text-center py-2 rounded-xl bg-[#8B5A8E] text-white text-sm font-bold"
      >
        辅线错题本
      </Link>
    </div>
  );
}
