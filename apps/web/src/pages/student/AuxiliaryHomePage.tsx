import { useNavigate, Link } from 'react-router-dom';
import AuxiliaryLayout from '@/components/business/AuxiliaryLayout';
import ConversationList from '@/components/business/ConversationList';
import AuxChatPanel from '@/components/business/AuxChatPanel';
import AuxInputBar from '@/components/business/AuxInputBar';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';
import { useChatStore } from '@/store/chatStore';
import { useAuxChat } from '@/hooks/useAuxChat';

const PlusIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-4 h-4"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const UserIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-5 h-5"
  >
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const ExitIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-5 h-5"
  >
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

export default function AuxiliaryHomePage() {
  const navigate = useNavigate();
  const { currentDialogueId, setCurrentDialogueId } = useAuxiliaryStore();
  const { messages, reset, isStreaming } = useChatStore();
  const { send, isLoadingHistory } = useAuxChat(currentDialogueId ?? 0);

  const username = localStorage.getItem('username') ?? '同学';

  const handleNewQuestion = () => {
    reset();
    setCurrentDialogueId(null);
  };

  const handleExit = () => navigate('/student/entry');

  const sidebar = (
    <>
      {/* 顶部：新问题 + 辅线错题本 */}
      <div className="p-4 border-b border-[var(--bg-subtle)] space-y-2">
        <button
          onClick={handleNewQuestion}
          className="w-full px-4 py-2.5 rounded-xl bg-[var(--brand-500)] text-white font-bold flex items-center justify-center gap-2 hover:opacity-90 transition"
        >
          <PlusIcon /> 新问题
        </button>
        <Link
          to="/student/error-book"
          className="block text-center py-2 rounded-xl text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)] transition"
        >
          辅线错题本
        </Link>
      </div>

      {/* 中间：历史会话列表 */}
      <div className="flex-1 overflow-hidden">
        <ConversationList />
      </div>

      {/* 底部：用户状态 + 退出 */}
      <div className="p-4 border-t border-[var(--bg-subtle)] flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <UserIcon />
          <span className="text-sm text-[var(--text-primary)] truncate">{username}</span>
        </div>
        <button
          onClick={handleExit}
          aria-label="退出答疑"
          className="p-2 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)] transition"
        >
          <ExitIcon />
        </button>
      </div>
    </>
  );

  return (
    <AuxiliaryLayout sidebar={sidebar}>
      {messages.length === 0 && !currentDialogueId ? (
        // 初始态：输入框居中
        <div className="flex-1 flex flex-col items-center justify-center px-6 pb-10">
          <h2 className="text-2xl sm:text-3xl font-bold text-[var(--text-primary)] mb-2">
            今天想探索什么？
          </h2>
          <p className="text-sm text-[var(--text-secondary)] mb-8">
            输入数学问题，或粘贴题目图片
          </p>
          <div className="w-full max-w-2xl">
            <AuxInputBar onSend={send} isStreaming={isStreaming} />
          </div>
        </div>
      ) : (
        // 对话态：对话窗口 + 底部输入框
        <>
          <AuxChatPanel isLoadingHistory={isLoadingHistory} />
          <div className="px-6 pb-6 pt-4 bg-[var(--bg-card)] border-t border-[var(--bg-subtle)]">
            <AuxInputBar key={currentDialogueId ?? 'new'} onSend={send} isStreaming={isStreaming} />
          </div>
        </>
      )}
    </AuxiliaryLayout>
  );
}
