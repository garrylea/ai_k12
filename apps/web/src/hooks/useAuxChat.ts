import { useEffect, useRef, useCallback, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { tutor, getMessages, type AttachmentRequest, type MessageItem } from '@/services/api';

export function useAuxChat(dialogueId: number) {
  const wsRef = useRef<WebSocket | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const {
    appendMessage,
    updateLastAssistant,
    appendToLastAssistant,
    setIsStreaming,
    setMessages,
  } = useChatStore();

  const fallbackToRest = useCallback(
    async (message: string, attachments?: AttachmentRequest[]) => {
      setIsStreaming(true);
      try {
        const res = await tutor({
          mode: 'auxiliary',
          message,
          dialogueId: dialogueId.toString(),
          attachments,
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

    let isCurrent = true;

    setIsLoadingHistory(true);
    getMessages(dialogueId)
      .then((items: MessageItem[]) => {
        if (!isCurrent) return;
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
      })
      .finally(() => {
        if (isCurrent) setIsLoadingHistory(false);
      });

    const token = localStorage.getItem('token') ?? '';
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${wsProtocol}//${window.location.host}/ws/ai/${dialogueId}?token=${token}`,
    );
    wsRef.current = ws;

    ws.onmessage = (event) => {
      if (!isCurrent) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
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
      if (!isCurrent) return;
      setIsStreaming(false);
    };

    return () => {
      isCurrent = false;
      ws.close();
    };
  }, [
    dialogueId,
    updateLastAssistant,
    appendToLastAssistant,
    setIsStreaming,
    setMessages,
  ]);

  const send = useCallback(
    async (content: string, attachments?: AttachmentRequest[]) => {
      if (!dialogueId) return;
      const { isStreaming } = useChatStore.getState();
      if (isStreaming) return;
      if (!content.trim() && !attachments?.length) return;

      // When attachments are present, append a [图片] indicator so the
      // rendered user message reflects what was actually sent.
      const userContent = attachments?.length
        ? `${content}${content ? ' ' : ''}[图片]`.trim()
        : content;
      appendMessage({ role: 'user', content: userContent });
      appendMessage({ role: 'assistant', content: '', streaming: true });
      setIsStreaming(true);

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ content, attachments }));
      } else {
        await fallbackToRest(content, attachments);
      }
    },
    [dialogueId, appendMessage, setIsStreaming, fallbackToRest],
  );

  return { send, isLoadingHistory };
}
