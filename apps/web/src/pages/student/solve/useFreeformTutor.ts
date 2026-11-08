import { useCallback, useRef } from 'react';
import { createConversation, streamTutorEvents, type AttachmentRequest } from '@/services/api';
import { useChatStore } from '@/store/chatStore';

/**
 * 自由作答页的「问 AI」答疑（`POST /api/ai/tutor/stream`），scene = `aux_freeform`。
 *
 * 刻意**不碰** `useAuxiliaryStore`：`aux_freeform` 会话不进答疑列表、不切换
 * 当前会话 —— 它只是本题的临时伴读。消息只写 `useChatStore`，判题/答疑共用
 * 同一个气泡容器。
 *
 * `ensureDialogue` 与 `send` 分开：页面先建会话（拿到 dialogueId 才能保证
 * 追问落在同一个上下文里），建失败时仍可只做本地展示。
 */
export function useFreeformTutor() {
  const abortRef = useRef<AbortController | null>(null);

  const ensureDialogue = useCallback(async (questionText: string, subjectId: number) => {
    const conv = await createConversation({
      track: 'auxiliary',
      scene: 'aux_freeform',
      subjectId,
      questionText,
    });
    return String(conv.id);
  }, []);

  const send = useCallback(
    async (
      dialogueId: string,
      text: string,
      attachments?: AttachmentRequest[],
      images?: string[],
    ) => {
      if (!text.trim() && !attachments?.length) return;

      const store = useChatStore.getState();
      if (store.isStreaming) return;

      store.appendMessage({ role: 'user', content: text.trim(), images });
      store.appendMessage({ role: 'assistant', content: '', streaming: true });
      store.setIsStreaming(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        for await (const event of streamTutorEvents(
          {
            mode: 'auxiliary',
            dialogueId,
            // 纯图片提问也要给后端一句非空 message（AIService 拒空）
            message: text.trim() || '帮我看一下这道题',
            attachments,
          },
          ctrl.signal,
        )) {
          const s = useChatStore.getState();
          if (event.type === 'reasoning' && event.delta) {
            s.appendLastAssistant({ reasoning: event.delta });
          } else if (event.type === 'content' && event.delta !== undefined) {
            if (event.replace) s.updateLastAssistant(event.delta);
            else s.appendLastAssistant({ content: event.delta });
          } else if (event.type === 'error') {
            s.setLastAssistantError({
              code: event.code ?? 5000,
              message: event.message ?? 'AI 服务异常',
              retryable: event.retryable ?? true,
              stage: 'tutor',
            });
          }
        }
      } catch (err) {
        // 学生主动停止：保留已流出的内容，不报网络错误
        if (!(err instanceof Error && err.name === 'AbortError')) {
          useChatStore.getState().setLastAssistantError({
            code: 1012,
            message: '网络连接失败，请重试',
            retryable: true,
            stage: 'tutor',
          });
        }
      } finally {
        useChatStore.getState().setIsStreaming(false);
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    },
    [],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { ensureDialogue, send, stop };
}
