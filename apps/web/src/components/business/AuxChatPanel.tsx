import { useChatStore } from '@/store/chatStore';

export default function AuxChatPanel() {
  const { messages, isStreaming } = useChatStore();

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4">
      {messages.map((m, idx) => (
        <div
          key={idx}
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
      ))}
    </div>
  );
}
