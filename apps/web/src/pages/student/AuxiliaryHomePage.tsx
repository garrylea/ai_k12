import AuxiliaryLayout from '@/components/business/AuxiliaryLayout';
import ConversationList from '@/components/business/ConversationList';
import AuxChatPanel from '@/components/business/AuxChatPanel';
import AuxInputBar from '@/components/business/AuxInputBar';
import { BackButton, LogoutButton } from '@/components/base';
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

export default function AuxiliaryHomePage() {
  const { currentDialogueId, setCurrentDialogueId } = useAuxiliaryStore();
  const { messages, reset, isStreaming } = useChatStore();
  const { send, stop, retry, confirmQuestion, reidentify, isLoadingHistory, deleteMsg } = useAuxChat(currentDialogueId ?? 0);

  const username = localStorage.getItem('username') ?? '同学';

  const handleNewQuestion = () => {
    reset();
    setCurrentDialogueId(null);
  };

  const sidebar = (
    <>
      {/* 顶部：返回入口 + 新问题 */}
      <div className="p-4 border-b border-[#E5E5E5] flex flex-col items-start gap-3">
        <BackButton to="/student/entry" label="返回辅学入口" />
        <button
          onClick={handleNewQuestion}
          className="w-full px-4 py-2.5 rounded-xl bg-[#FF6B00] text-white font-bold flex items-center justify-center gap-2 hover:opacity-90 transition"
        >
          <PlusIcon /> 新问题
        </button>
      </div>

      {/* 中间：历史会话列表 */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <ConversationList />
      </div>

      {/* 底部：用户状态 + 退出 */}
      <div className="p-4 border-t border-[#E5E5E5] flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <UserIcon />
          <span className="text-sm text-[#1D1D1F] truncate">{username}</span>
        </div>
        <LogoutButton onLogout={() => { reset(); setCurrentDialogueId(null); }} />
      </div>
    </>
  );

  return (
    <AuxiliaryLayout sidebar={sidebar}>
      {messages.length === 0 && !currentDialogueId ? (
        // 初始态：输入框居中
        <div className="flex-1 flex flex-col items-center justify-center px-6 pb-10">
          <h2 className="text-2xl sm:text-3xl font-bold text-[#1D1D1F] mb-2">
            今天想探索什么？
          </h2>
          <p className="text-sm text-[#86868B] mb-8">
            输入数学问题，或粘贴题目图片
          </p>
          <div className="w-full max-w-2xl">
            <AuxInputBar onSend={send} onStop={stop} isStreaming={isStreaming} />
          </div>
        </div>
      ) : (
        // 对话态：对话窗口 + 底部输入框
        <>
          <AuxChatPanel isLoadingHistory={isLoadingHistory} onRetry={retry} onConfirm={confirmQuestion} onReidentify={reidentify} onDelete={deleteMsg} />
          <div className="px-6 pb-6 pt-4 bg-white border-t border-[#E5E5E5]">
            <AuxInputBar key={currentDialogueId ?? 'new'} onSend={send} onStop={stop} isStreaming={isStreaming} />
          </div>
        </>
      )}
    </AuxiliaryLayout>
  );
}
