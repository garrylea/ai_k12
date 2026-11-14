import { useCallback, useRef } from 'react';
import { createConversation, streamTutorEvents, type AttachmentRequest } from '@/services/api';
import { useChatStore } from '@/store/chatStore';

/** 做题页专有：学科（决定用哪个学科模块模板）。空值不写键。 */
export interface FreeformTutorOptions {
  subjectId?: number;
}

/** 本页专有的发送上下文：`retry()` 靠它原样重发上一问，不再追加用户气泡。 */
interface SendContext {
  dialogueId: string;
  text: string;
  attachments?: AttachmentRequest[];
  opts?: FreeformTutorOptions;
}

/**
 * 自由作答页的「问 AI」答疑（`POST /api/ai/tutor/stream`），scene = `aux_freeform`。
 *
 * 刻意**不碰** `useAuxiliaryStore`：`aux_freeform` 会话不进答疑列表、不切换
 * 当前会话 —— 它只是本题的临时伴读。消息只写 `useChatStore`，判题/答疑共用
 * 同一个气泡容器。
 *
 * `ensureDialogue` 与 `send` 分开：页面先建会话（拿到 dialogueId 才能保证
 * 追问落在同一个上下文里），建失败时仍可只做本地展示。
 *
 * 失败后的 `retry()` 复用上一次发送参数、只重发流，不再追加用户气泡。
 */
export function useFreeformTutor() {
  const abortRef = useRef<AbortController | null>(null);
  // 上一次发送的原始参数（会话 / 提问 / 附件 / 学科），失败后「重试」直接用
  const lastSendRef = useRef<SendContext | null>(null);

  const ensureDialogue = useCallback(async (questionText: string, subjectId: number) => {
    const conv = await createConversation({
      track: 'auxiliary',
      scene: 'aux_freeform',
      subjectId,
      questionText,
    });
    return String(conv.id);
  }, []);

  /** 消费一条答疑流；助手气泡已由调用方就位（send 新建 / retry 复位）。 */
  const runStream = useCallback(async (ctx: SendContext) => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    useChatStore.getState().setIsStreaming(true);
    try {
      for await (const event of streamTutorEvents(
        {
          mode: 'auxiliary',
          dialogueId: ctx.dialogueId,
          // 纯图片提问也要给后端一句非空 message（AIService 拒空）
          message: ctx.text || '帮我看一下这道题',
          attachments: ctx.attachments,
          // 学习档案由服务端从 DB 取；前端只报学科。
          // 只在有值时才写键：其它入口（辅线答疑）的请求体保持原样
          ...(ctx.opts?.subjectId ? { subjectId: ctx.opts.subjectId } : {}),
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
  }, []);

  const send = useCallback(
    async (
      dialogueId: string,
      text: string,
      attachments?: AttachmentRequest[],
      images?: string[],
      opts?: FreeformTutorOptions,
    ) => {
      if (!text.trim() && !attachments?.length) return;

      const store = useChatStore.getState();
      if (store.isStreaming) return;

      const ctx: SendContext = {
        dialogueId,
        text: text.trim(),
        attachments,
        opts,
      };
      lastSendRef.current = ctx;

      store.appendMessage({ role: 'user', content: ctx.text, images });
      store.appendMessage({ role: 'assistant', content: '', streaming: true });

      await runStream(ctx);
    },
    [runStream],
  );

  /** 错误气泡的「重试」：复位上一条助手气泡后就地重发，不再追加用户气泡。 */
  const retry = useCallback(async () => {
    const ctx = lastSendRef.current;
    if (!ctx) return;
    if (useChatStore.getState().isStreaming) return;

    useChatStore.getState().resetLastAssistantToStreaming();
    await runStream(ctx);
  }, [runStream]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { ensureDialogue, send, retry, stop };
}
