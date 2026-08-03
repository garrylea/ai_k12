import { useEffect, useRef, useCallback } from 'react';
import { useChatStore } from '@/store/chatStore';
import { tutor, getMessages, type MessageItem } from '@/services/api';

export function useAuxChat(dialogueId: number) {
  const wsRef = useRef<WebSocket | null>(null);
  const {
    appendMessage,
    updateLastAssistant,
    appendToLastAssistant,
    setIsStreaming,
    setMessages,
  } = useChatStore();

  const fallbackToRest = useCallback(
    async (message: string) => {
      setIsStreaming(true);
      try {
        const res = await tutor({
          mode: 'auxiliary',
          message,
          dialogueId: dialogueId.toString(),
        });
        updateLastAssistant(res.message.content);
      } catch {
        updateLastAssistant('[网络异常] 请稍后重试');
      } finally {
        setIsStreaming(false);
      }
    },
    [dialogueId, updateLastAssistant, setIsStreaming],
  );

  useEffect(() => {
    if (!dialogueId) return;

    getMessages(dialogueId)
      .then((items: MessageItem[]) => {
        setMessages(
          items
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({
              id: m.id,
              role: m.role as 'user' | 'assistant',
              content: m.content,
              type: m.type ?? undefined,
            })),
        );
      })
      .catch(() => {
        // ignore load errors - user can still send new messages
      });

    const token = localStorage.getItem('token') ?? '';
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${wsProtocol}//${window.location.host}/ws/ai/${dialogueId}?token=${token}`,
    );
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'token') {
        appendToLastAssistant(msg.payload.content);
      } else if (msg.type === 'full') {
        updateLastAssistant(msg.payload.content);
        setIsStreaming(false);
      } else if (msg.type === 'done' || msg.type === 'end') {
        setIsStreaming(false);
      } else if (msg.type === 'safety_alert') {
        updateLastAssistant('[系统提示] 请保持学习相关话题');
        setIsStreaming(false);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      setIsStreaming(false);
    };

    return () => ws.close();
  }, [
    dialogueId,
    updateLastAssistant,
    appendToLastAssistant,
    setIsStreaming,
    setMessages,
  ]);

  const send = useCallback(
    async (content: string) => {
      appendMessage({ role: 'user', content });
      appendMessage({ role: 'assistant', content: '', streaming: true });
      setIsStreaming(true);

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ content }));
      } else {
        await fallbackToRest(content);
      }
    },
    [appendMessage, setIsStreaming, fallbackToRest],
  );

  return { send };
}
