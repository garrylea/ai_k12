import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';
import { useChatStore } from '@/store/chatStore';
import {
  listAllConversations,
  renameConversation,
  deleteConversation,
  type ConversationItem,
} from '@/services/api';
import { relativeTime, stripTitleDate } from '@/utils/time';
import { BackButton } from '@/components/base';

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);
const EditIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const XIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export default function ConversationManagePage() {
  const navigate = useNavigate();
  const {
    conversations,
    setConversations,
    updateConversationTitle,
    removeConversation,
    currentDialogueId,
    setCurrentDialogueId,
  } = useAuxiliaryStore();
  const { reset } = useChatStore();

  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAllConversations('auxiliary')
      .then((items) => {
        if (!cancelled) {
          setConversations(items);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('会话列表加载失败');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [setConversations, reloadKey]);

  const filtered = query.trim()
    ? conversations.filter((c) =>
        stripTitleDate(c.title).toLowerCase().includes(query.trim().toLowerCase()),
      )
    : conversations;

  const startEdit = (c: ConversationItem) => {
    setEditingId(c.id);
    setEditTitle(stripTitleDate(c.title));
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditTitle('');
  };
  const saveEdit = async (id: number) => {
    const t = editTitle.trim();
    if (!t) return;
    setBusyId(id);
    try {
      await renameConversation(id, t);
      updateConversationTitle(id, t);
      setEditingId(null);
      setEditTitle('');
    } catch {
      alert('改名失败，请重试');
    } finally {
      setBusyId(null);
    }
  };
  const handleDelete = async (c: ConversationItem) => {
    if (!window.confirm(`确定删除会话「${stripTitleDate(c.title) || '未命名'}」吗？删除后不可恢复。`)) return;
    setBusyId(c.id);
    try {
      await deleteConversation(c.id);
      removeConversation(c.id);
      if (c.id === currentDialogueId) {
        setCurrentDialogueId(null);
        reset();
      }
    } catch {
      alert('删除失败，请重试');
    } finally {
      setBusyId(null);
    }
  };

  const openConversation = (c: ConversationItem) => {
    setCurrentDialogueId(c.id);
    navigate('/student/auxiliary');
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 sm:p-6 lg:p-8"
      data-theme="student-day"
      data-school="junior"
      style={{ backgroundColor: '#F5F0E8' }}
    >
      <div
        className="w-full max-w-3xl h-[85vh] min-h-[600px] flex flex-col rounded-3xl bg-white border border-[#E5E5E5] overflow-hidden"
        style={{ boxShadow: '0 2px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)' }}
      >
        {/* header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-[#E5E5E5]">
          <BackButton to="/student/auxiliary" label="返回答疑" />
          <h1 className="text-lg font-bold text-[#1D1D1F]">会话管理</h1>
          <span className="ml-auto text-xs text-[#A0A0A5]">共 {conversations.length} 条</span>
        </div>

        {/* search */}
        <div className="px-6 py-3 border-b border-[#E5E5E5]">
          <div className="flex items-center gap-2 px-3 h-10 rounded-xl bg-[#F9F9FB] border border-[#E5E5E5] focus-within:border-[#FF6B00] transition">
            <span className="text-[#A0A0A5] flex-shrink-0">
              <SearchIcon />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索对话名称..."
              className="flex-1 bg-transparent outline-none text-sm text-[#1D1D1F] placeholder:text-[#A0A0A5]"
            />
          </div>
        </div>

        {/* list */}
        <div className="flex-1 overflow-auto px-6 py-2 min-h-0">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-[#86868B]">
              加载中...
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="text-sm text-[#86868B]">{error}</p>
              <button
                onClick={() => setReloadKey((k) => k + 1)}
                className="px-4 py-2 rounded-lg text-sm bg-[#FF6B00] text-white hover:opacity-90 transition"
              >
                重试
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-[#86868B]">
              {query.trim() ? '没有匹配的会话' : '暂无历史会话'}
            </div>
          ) : (
            <ul className="divide-y divide-[#F0F0F2]">
              {filtered.map((c) => (
                <li key={c.id} className="flex items-center gap-2 py-3">
                  {editingId === c.id ? (
                    <>
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEdit(c.id);
                          if (e.key === 'Escape') cancelEdit();
                        }}
                        className="flex-1 px-3 h-9 rounded-lg border border-[#FF6B00] outline-none text-sm text-[#1D1D1F] bg-white"
                      />
                      <button
                        onClick={() => saveEdit(c.id)}
                        disabled={busyId === c.id || !editTitle.trim()}
                        className="p-1.5 rounded-lg text-[#FF6B00] hover:bg-[#FFF0E5] disabled:opacity-40 transition"
                        aria-label="保存"
                      >
                        <CheckIcon />
                      </button>
                      <button
                        onClick={cancelEdit}
                        disabled={busyId === c.id}
                        className="p-1.5 rounded-lg text-[#86868B] hover:bg-[#F9F9FB] disabled:opacity-40 transition"
                        aria-label="取消"
                      >
                        <XIcon />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => openConversation(c)}
                        className="flex-1 text-left min-w-0"
                      >
                        <div className="text-sm text-[#1D1D1F] truncate">
                          {stripTitleDate(c.title) || '未命名会话'}
                        </div>
                        <div className="text-xs text-[#A0A0A5] mt-0.5">
                          {relativeTime(c.created_at)}
                        </div>
                      </button>
                      <button
                        onClick={() => startEdit(c)}
                        disabled={busyId === c.id}
                        className="p-1.5 rounded-lg text-[#86868B] hover:bg-[#F9F9FB] hover:text-[#1D1D1F] disabled:opacity-40 transition"
                        aria-label="改名"
                      >
                        <EditIcon />
                      </button>
                      <button
                        onClick={() => handleDelete(c)}
                        disabled={busyId === c.id}
                        className="p-1.5 rounded-lg text-[#86868B] hover:bg-[#F9F9FB] hover:text-[#E5484D] disabled:opacity-40 transition"
                        aria-label="删除"
                      >
                        <TrashIcon />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
