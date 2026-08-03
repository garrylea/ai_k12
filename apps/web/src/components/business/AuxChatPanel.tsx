import { useRef, useEffect } from 'react';
import { useChatStore } from '@/store/chatStore';

interface Props {
  isLoadingHistory?: boolean;
}

export default function AuxChatPanel({ isLoadingHistory = false }: Props) {
  const { messages, isStreaming } = useChatStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4">
      {isLoadingHistory && messages.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-[var(--text-secondary)]">
          加载中...
        </div>
      ) : (
        messages.map((m, idx) => (
          <div
            key={m.id ?? `optimistic-${idx}`}
            className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[70%] px-4 py-3 rounded-2xl text-sm ${
                m.role === 'user'
                  ? 'bg-[var(--aux)] text-white'
                  : 'bg-[var(--bg-card)] text-[var(--text-primary)]'
              }`}
            >
              {m.content || (isStreaming && m.streaming ? '▍' : '')}
            </div>
          </div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}
