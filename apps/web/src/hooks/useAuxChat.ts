import { useEffect, useRef, useCallback, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';
import {
  tutor,
  getMessages,
  createConversation,
  type AttachmentRequest,
  type MessageItem,
} from '@/services/api';

export function useAuxChat(dialogueId: number) {
  const wsRef = useRef<WebSocket | null>(null);
  // Tracks a dialogue created mid-session so the history-load effect can
  // skip fetching (no messages exist yet) and preserve messages appended
  // by send().
  const newlyCreatedRef = useRef<number | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const {
    appendMessage,
    updateLastAssistant,
    appendToLastAssistant,
    setIsStreaming,
    setMessages,
  } = useChatStore();

  const fallbackToRest = useCallback(
    async (dlgId: number, message: string, attachments?: AttachmentRequest[]) => {
      setIsStreaming(true);
      try {
        const res = await tutor({
          mode: 'auxiliary',
          message,
          dialogueId: dlgId.toString(),
          attachments,
        });
        updateLastAssistant(res.message.content);
      } catch {
        updateLastAssistant('[网络异常] 请稍后重试');
      } finally {
        setIsStreaming(false);
      }
    },
    [updateLastAssistant, setIsStreaming],
  );

  useEffect(() => {
    if (!dialogueId) return;

    let isCurrent = true;

    // Skip history load for dialogues created in the same session - there
    // are no persisted messages yet, and calling setMessages([]) would wipe
    // the messages just appended by send().
    if (newlyCreatedRef.current === dialogueId) {
      newlyCreatedRef.current = null;
    } else {
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
    }

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
      const { isStreaming } = useChatStore.getState();
      if (isStreaming) return;
      if (!content.trim() && !attachments?.length) return;

      let dlgId = dialogueId;
      if (!dlgId) {
        // First send in a new session - create the dialogue now.
        try {
          const conv = await createConversation({ track: 'auxiliary' });
          dlgId = conv.id;
          newlyCreatedRef.current = conv.id;
          const auxStore = useAuxiliaryStore.getState();
          auxStore.setCurrentDialogueId(conv.id);
          auxStore.prependConversation(conv);
        } catch {
          return;
        }
      }

      // When attachments are present, append a [图片] indicator so the
      // rendered user message reflects what was actually sent.
      const userContent = attachments?.length
        ? `${content}${content ? ' ' : ''}[图片]`.trim()
        : content;
      appendMessage({ role: 'user', content: userContent });
      appendMessage({ role: 'assistant', content: '', streaming: true });
      setIsStreaming(true);

      const ws = wsRef.current;
      // WS gateway does not support attachments yet; force REST (which
      // Task 14a backend handles) when attachments are present.
      if (ws && ws.readyState === WebSocket.OPEN && !attachments?.length) {
        ws.send(JSON.stringify({ content }));
      } else {
        await fallbackToRest(dlgId, content, attachments);
      }
    },
    [dialogueId, appendMessage, setIsStreaming, fallbackToRest],
  );

  return { send, isLoadingHistory };
}
