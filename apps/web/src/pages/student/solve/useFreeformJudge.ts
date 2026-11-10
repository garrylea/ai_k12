import { useCallback, useRef, useState } from 'react';
import { streamFreeformJudge, type FreeformJudgeBody, type FreeformJudgeEvent } from '@/services/api';
import { useChatStore } from '@/store/chatStore';

/** 判题流多久没有任何事件就判定为「卡死」（后端模型空闲超时是 10s，这里只兜底真挂起）。 */
export const JUDGE_INACTIVITY_MS = 120_000;

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
 * - 失败后 `retry()` 只重发判题流（复用上次 body，不新起用户气泡、不重传图片/草稿）。
 */
export function useFreeformJudge() {
  const [submitting, setSubmitting] = useState(false);
  // 学生主动停止：与「失败」分开——不算错误，但也不能把界面打回编辑器装没事发生
  const [stopped, setStopped] = useState(false);
  const [questionId, setQuestionId] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<FreeformJudgeResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timedOutRef = useRef(false);
  // 重试用的原始上行 body：与 display 分开存，重试不能再触发一次上传/用户气泡
  const lastBodyRef = useRef<FreeformJudgeBody | null>(null);

  /** 消费一条判题流；助手气泡已由调用方就位（submit 新建 / retry 复位）。 */
  const runStream = useCallback(async (body: FreeformJudgeBody) => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    useChatStore.getState().setIsStreaming(true);
    setSubmitting(true);
    setStopped(false);
    timedOutRef.current = false;
    // 每收到一条事件就续命：模型思考再久也没事，只有「完全没有数据」才算卡死
    const armWatchdog = () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = setTimeout(() => {
        timedOutRef.current = true;
        ctrl.abort();
      }, JUDGE_INACTIVITY_MS);
    };
    armWatchdog();
    try {
      for await (const event of streamFreeformJudge(body, ctrl.signal)) {
        armWatchdog();
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
            stage: 'judge',
          });
        }
        // start / done 不改 UI：流结束在 finally 里复位
      }
    } catch (err) {
      // 学生主动点停止（AbortError）保留已流出的判题过程，不算错误；
      // 但静默超时导致的 abort 必须报错，否则页面会无限转圈。
      if (err instanceof Error && err.name === 'AbortError') {
        if (timedOutRef.current) {
          useChatStore.getState().setLastAssistantError({
            code: 1009,
            message: 'AI 响应超时，请重试',
            retryable: true,
            stage: 'judge',
          });
        }
      } else {
        useChatStore.getState().setLastAssistantError({
          code: 1012,
          message: '网络连接失败，请重试',
          retryable: true,
          stage: 'judge',
        });
      }
    } finally {
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
      useChatStore.getState().setIsStreaming(false);
      setSubmitting(false);
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }, []);

  const submit = useCallback(
    async (
      body: FreeformJudgeBody,
      display?: { images?: string[]; answerMarkdown?: string },
    ) => {
      const store = useChatStore.getState();
      if (store.isStreaming) return;

      lastBodyRef.current = body;

      // 重新判题必须先清掉上一轮的结果：新流若中途失败/被停，页面不能继续
      // 展示上一次的 questionId / 分数（会指到另一条错题、显示过期得分）。
      setQuestionId(null);
      setLastResult(null);

      store.appendMessage({
        role: 'user',
        content: display?.answerMarkdown ?? body.answer,
        images: display?.images,
        markdown: true,
      });
      store.appendMessage({ role: 'assistant', content: '', streaming: true });

      await runStream(body);
    },
    [runStream],
  );

  /** 错误气泡的「重试」：复位上一条助手气泡后就地重发，不再追加用户气泡。 */
  const retry = useCallback(async () => {
    const body = lastBodyRef.current;
    if (!body) return;
    if (useChatStore.getState().isStreaming) return;

    useChatStore.getState().resetLastAssistantToStreaming();
    await runStream(body);
  }, [runStream]);

  const stop = useCallback(() => {
    if (!abortRef.current) return;
    setStopped(true);
    abortRef.current.abort();
  }, []);

  /** 换题（做题错题重练）用：中断旧流、清空判题状态与消息，不复用上一条 body。 */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    timedOutRef.current = false;
    lastBodyRef.current = null;
    setSubmitting(false);
    setStopped(false);
    setQuestionId(null);
    setLastResult(null);
    useChatStore.getState().reset();
  }, []);

  return { submitting, stopped, questionId, lastResult, submit, retry, stop, reset };
}
