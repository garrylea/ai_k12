import { useCallback, useRef, useState } from 'react';
import { streamFreeformJudge, type FreeformJudgeBody, type FreeformJudgeEvent } from '@/services/api';
import { useChatStore } from '@/store/chatStore';

/** 判题成功事件，页面用它的分数/判定渲染报告头。 */
export type FreeformJudgeResult = Extract<FreeformJudgeEvent, { type: 'result' }>;

/**
 * 自由作答页的判题流（`POST /api/freeform/judge/stream`）。
 *
 * 与答疑共用 `useChatStore`：用户气泡（Markdown 渲染，含题图）+ 助手流式气泡。
 * 判题结果额外回传 `questionId` / `lastResult`，页面拿去跳错题本或展示得分。
 *
 * 约束：
 * - `isStreaming` 为真时**不许**起流 —— 否则第二个流会往同一条助手气泡里追加。
 * - 学生点停止走 abort，不算错误，不弹网络失败。
 */
export function useFreeformJudge() {
  const [submitting, setSubmitting] = useState(false);
  const [questionId, setQuestionId] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<FreeformJudgeResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const submit = useCallback(
    async (
      body: FreeformJudgeBody,
      display?: { images?: string[]; answerMarkdown?: string },
    ) => {
      const store = useChatStore.getState();
      if (store.isStreaming) return;

      store.appendMessage({
        role: 'user',
        content: display?.answerMarkdown ?? body.answer,
        images: display?.images,
        markdown: true,
      });
      store.appendMessage({ role: 'assistant', content: '', streaming: true });
      store.setIsStreaming(true);
      setSubmitting(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        for await (const event of streamFreeformJudge(body, ctrl.signal)) {
          if (event.type === 'reasoning') {
            useChatStore.getState().appendLastAssistant({ reasoning: event.delta });
          } else if (event.type === 'content') {
            if (event.replace) useChatStore.getState().updateLastAssistant(event.delta);
            else useChatStore.getState().appendLastAssistant({ content: event.delta });
          } else if (event.type === 'result') {
            setQuestionId(event.questionId);
            setLastResult(event);
          } else if (event.type === 'error') {
            useChatStore.getState().setLastAssistantError({
              code: event.code,
              message: event.message,
              retryable: event.retryable,
            });
          }
          // start / done 不改 UI：流结束在 finally 里复位
        }
      } catch {
        useChatStore.getState().setLastAssistantError({
          code: 1012,
          message: '网络连接失败，请重试',
          retryable: true,
        });
      } finally {
        useChatStore.getState().setIsStreaming(false);
        setSubmitting(false);
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    },
    [],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { submitting, questionId, lastResult, submit, stop };
}
