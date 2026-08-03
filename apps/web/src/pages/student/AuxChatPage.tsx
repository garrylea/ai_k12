import { useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import AuxiliaryLayout from '@/components/business/AuxiliaryLayout';
import ConversationList from '@/components/business/ConversationList';
import AuxChatPanel from '@/components/business/AuxChatPanel';
import AuxInputBar from '@/components/business/AuxInputBar';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';
import { useChatStore } from '@/store/chatStore';
import { useAuxChat } from '@/hooks/useAuxChat';
import { createConversation } from '@/services/api';

export default function AuxChatPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const knowledgePointId = params.get('knowledgePointId');
  const { currentDialogueId, setCurrentDialogueId } = useAuxiliaryStore();
  const { reset } = useChatStore();
  const { send } = useAuxChat(currentDialogueId ?? 0);

  useEffect(() => {
    if (!currentDialogueId) {
      createConversation({
        track: 'auxiliary',
        knowledgePointId: knowledgePointId ? Number(knowledgePointId) : undefined,
      })
        .then((conv) => setCurrentDialogueId(conv.id))
        .catch(() => {
          // ignore - user can retry by navigating
        });
    }
    return () => reset();
  }, [currentDialogueId, knowledgePointId, setCurrentDialogueId, reset]);

  return (
    <AuxiliaryLayout sidebar={<ConversationList />}>
      <header className="h-16 border-b border-[var(--bg-subtle)] flex items-center justify-between px-6 bg-[var(--bg-card)]">
        <span className="text-sm text-[var(--text-secondary)]">答疑轨 · 限 K12 学科</span>
        <div className="flex gap-3">
          <button
            onClick={() => navigate('/student/entry')}
            className="px-4 py-2 rounded-lg text-sm border border-[var(--bg-subtle)] text-[var(--text-primary)]"
          >
            退出答疑
          </button>
          <button
            onClick={() => {
              setCurrentDialogueId(null);
              navigate('/student/auxiliary/chat');
            }}
            className="px-4 py-2 rounded-lg text-sm bg-[var(--aux)] text-white"
          >
            下一个问题
          </button>
        </div>
      </header>
      <AuxChatPanel />
      <AuxInputBar
        onSend={send}
        onUpload={(file) => navigate('/student/auxiliary/ask', { state: { file } })}
      />
    </AuxiliaryLayout>
  );
}
