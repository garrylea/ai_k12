import { useEffect, useRef, useCallback, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';
import {
  tutor,
  getMessages,
  createConversation,
  ApiError,
  type AttachmentRequest,
  type MessageItem,
} from '@/services/api';
import { toast } from '@/components/base/Toast';

// Severe non-retryable errors (quota / auth / permission) warrant a toast in
// addition to the inline error bubble.
const SEVERE_ERROR_CODES = [1005, 1006, 1007];

interface StreamEvent {
  type: 'reasoning' | 'content' | 'done' | 'error' | 'flow';
  delta?: string;
  replace?: boolean;
  message?: string;
  code?: number;
  retryable?: boolean;
  // flow event fields (P1 image two-stage):
  stage?: 'select' | 'confirm' | 'unrecognizable';
  question?: string;
  problems?: { index: number; text: string }[];
}

// Cached send context so retry() can re-send the last user message without the
// caller passing it again. Cleared implicitly when a new dialogue is loaded.
interface SendContext {
  dlgId: number;
  message: string;
  attachments?: AttachmentRequest[];
}

export function useAuxChat(dialogueId: number) {
  // Tracks a dialogue created mid-session so the history-load effect can
  // skip fetching (no messages exist yet) and preserve messages appended
  // by send().
  const newlyCreatedRef = useRef<number | null>(null);
  // AbortController for the in-flight stream so stop() can cancel it.
  const abortRef = useRef<AbortController | null>(null);
  // Last send context (message + attachments + dialogueId) so retry() can
  // re-generate the last turn. Null after reload (rebuilt from store history).
  const lastSendRef = useRef<SendContext | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const {
    appendMessage,
    updateLastAssistant,
    appendLastAssistant,
    setLastAssistantError,
    setLastAssistantFlow,
    resetLastAssistantToStreaming,
    setIsStreaming,
    setMessages,
  } = useChatStore();

  // Non-streaming fallback (used only if the SSE stream fails to start).
  const fallbackToRest = useCallback(
    async (dlgId: number, message: string, attachments?: AttachmentRequest[], retry = false) => {
      setIsStreaming(true);
      try {
        const res = await tutor({
          mode: 'auxiliary',
          message,
          dialogueId: dlgId.toString(),
          attachments,
          ...(retry ? { retry: true } : {}),
        });
        updateLastAssistant(res.message.content, res.reasoning);
      } catch (err) {
        // Surface the structured error (don't swallow ApiError) so the user sees
        // a specific reason (quota / auth / network) and a retry button.
        let code: number;
        let message: string;
        let retryable: boolean;
        if (err instanceof ApiError) {
          code = err.code;
          message = err.message;
          retryable = err.retryable ?? false;
        } else {
          code = 1012;
          message = '网络连接失败，请检查网络后重试';
          retryable = true;
        }
        setLastAssistantError({ code, message, retryable, stage: 'tutor' });
        if (SEVERE_ERROR_CODES.includes(code)) toast('error', message);
      } finally {
        setIsStreaming(false);
      }
    },
    [setLastAssistantError, setIsStreaming],
  );

  // Streaming tutor over SSE. Consumes reasoning + content deltas, then done.
  // Throws only if the stream fails to START (network / no body); mid-stream
  // errors arrive as `{type:'error'}` events and are handled inline. A user
  // stop (AbortError) keeps the partial content and does NOT fall back to REST.
  const streamTutor = useCallback(
    async (dlgId: number, message: string, attachments?: AttachmentRequest[], retry = false, flowAction?: 'confirm' | 'reidentify' | 'correct') => {
      const token = localStorage.getItem('token') ?? '';
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch('/api/ai/tutor/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            mode: 'auxiliary',
            message,
            dialogueId: dlgId.toString(),
            attachments,
            ...(retry ? { retry: true } : {}),
            ...(flowAction ? { flowAction } : {}),
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error('stream unavailable');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            let event: StreamEvent;
            try {
              event = JSON.parse(trimmed.slice(6));
            } catch {
              continue;
            }
            if (event.type === 'reasoning' && event.delta) {
              appendLastAssistant({ reasoning: event.delta });
            } else if (event.type === 'content' && event.delta !== undefined) {
              if (event.replace) updateLastAssistant(event.delta);
              else appendLastAssistant({ content: event.delta });
            } else if (event.type === 'error') {
              const code = event.code ?? 5000;
              const message = event.message ?? 'AI 服务异常，请稍后重试';
              setLastAssistantError({
                code,
                message,
                retryable: event.retryable ?? true,
                stage: 'tutor',
              });
              if (SEVERE_ERROR_CODES.includes(code)) toast('error', message);
            } else if (event.type === 'flow') {
              // P1: image two-stage flow event. Populate the assistant bubble
              // with the transcription/result and attach the flow UI state.
              if (event.stage === 'confirm' && event.question) {
                setLastAssistantFlow({ stage: 'confirm', question: event.question }, event.question);
              } else if (event.stage === 'select' && event.problems) {
                const list = event.problems.map(p => `第${p.index}题：${p.text}`).join('\n\n');
                setLastAssistantFlow({ stage: 'select', problems: event.problems }, list);
              } else if (event.stage === 'unrecognizable') {
                setLastAssistantFlow({ stage: 'unrecognizable' }, '无法识别图片中的题目，请重新拍摄清晰的照片后上传。');
              }
            }
            // done: isStreaming reset in finally
          }
        }
      } catch (err) {
        // User clicked stop -> keep partial content, no REST fallback.
        if (err instanceof Error && err.name === 'AbortError') return;
        throw err;  // real start error -> send() falls back to non-stream REST
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setIsStreaming(false);
      }
    },
    [appendLastAssistant, updateLastAssistant, setLastAssistantError, setLastAssistantFlow, setIsStreaming],
  );

  // Abort the in-flight stream (stop button). The backend aborts the upstream
  // LLM fetch and best-effort persists the partial turn so context is retained.
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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
              .map((m) => {
                // Parse persisted attachments (JSON string of {type,url}[]) back
                // into display image URLs so history re-renders sent images.
                let images: string[] | undefined;
                if (m.attachments) {
                  try {
                    const parsed = JSON.parse(m.attachments) as Array<{ type: string; url: string }>;
                    const urls = parsed
                      .filter((a) => a.type === 'image' && !!a.url)
                      .map((a) => a.url);
                    if (urls.length) images = urls;
                  } catch {
                    // ignore malformed attachments JSON
                  }
                }
                return {
                  id: m.id,
                  role: m.role as 'user' | 'assistant',
                  content: m.content,
                  reasoning: m.reasoning ?? undefined,
                  type: m.type ?? undefined,
                  images,
                };
              }),
          );
        })
        .catch(() => {
          // ignore load errors - user can still send new messages
        })
        .finally(() => {
          if (isCurrent) setIsLoadingHistory(false);
        });
    }

    return () => {
      isCurrent = false;
    };
  }, [dialogueId, setMessages]);

  const send = useCallback(
    async (content: string, attachments?: AttachmentRequest[], images?: string[], explicitFlowAction?: 'confirm' | 'reidentify' | 'correct') => {
      const { isStreaming, messages } = useChatStore.getState();
      if (isStreaming) return;
      // P1: typing during the confirm step is a correction (flowAction='correct').
      const last = messages[messages.length - 1];
      const inConfirm = last?.role === 'assistant' && last.flow?.stage === 'confirm';
      const flowAction = explicitFlowAction ?? (inConfirm && content.trim() ? 'correct' : undefined);
      if (!content.trim() && !attachments?.length && !flowAction) return;

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

      // Image-only sends still need a non-empty message for the backend
      // (AIService rejects empty `message`). Use a default prompt; the
      // rendered bubble shows the image itself, not this text.
      const apiMessage = content.trim() || (flowAction ? '' : '帮我看一下这道题');
      // Cache context so retry() can re-send this exact turn.
      lastSendRef.current = { dlgId, message: apiMessage, attachments };
      // User bubble: show the action label for confirm/reidentify, else the content.
      const userDisplay = flowAction === 'confirm' ? '确认'
        : flowAction === 'reidentify' ? '重新识别'
        : content.trim();
      appendMessage({ role: 'user', content: userDisplay, images });
      appendMessage({ role: 'assistant', content: '', streaming: true });
      setIsStreaming(true);

      try {
        await streamTutor(dlgId, apiMessage, attachments, false, flowAction);
      } catch {
        // Stream failed to start (network / no body) - fall back to non-stream REST.
        // Note: REST fallback does not support flow actions (rare; surfaces as error).
        await fallbackToRest(dlgId, apiMessage || '帮我看一下这道题', attachments);
      }

      // Refresh the conversation list: the backend names the conversation from
      // the user's question (fire-and-forget, ~1-2s), so refresh now and again
      // after a delay to pick up the new title.
      useAuxiliaryStore.getState().fetchConversations();
      setTimeout(() => useAuxiliaryStore.getState().fetchConversations(), 2000);
    },
    [dialogueId, appendMessage, setIsStreaming, streamTutor, fallbackToRest],
  );

  // P1: image two-stage flow action shortcuts (confirm / re-identify buttons).
  const confirmQuestion = useCallback(() => send('', undefined, undefined, 'confirm'), [send]);
  const reidentify = useCallback(() => send('', undefined, undefined, 'reidentify'), [send]);

  // Re-generate the last turn after an error (P2). Reuses the cached send
  // context, or rebuilds from the last user message in the store (reload-after-
  // error case). Passes retry:true so the backend skips re-persisting the
  // (already-stored) user message - only the assistant reply is stored.
  const retry = useCallback(async () => {
    const { isStreaming, messages } = useChatStore.getState();
    if (isStreaming) return;
    let ctx = lastSendRef.current;
    if (!ctx) {
      // Reload case: last user message has no assistant reply yet.
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUser) ctx = { dlgId: dialogueId, message: lastUser.content };
    }
    if (!ctx || !ctx.dlgId) return;
    const apiMessage = ctx.message.trim() || '帮我看一下这道题';
    // Replace the error bubble (or append a placeholder) with a fresh streaming
    // placeholder, then re-call the model.
    resetLastAssistantToStreaming();
    try {
      await streamTutor(ctx.dlgId, apiMessage, ctx.attachments, true);
    } catch {
      await fallbackToRest(ctx.dlgId, apiMessage, ctx.attachments, true);
    }
    useAuxiliaryStore.getState().fetchConversations();
  }, [dialogueId, resetLastAssistantToStreaming, streamTutor, fallbackToRest]);

  return { send, stop, retry, confirmQuestion, reidentify, isLoadingHistory };
}
