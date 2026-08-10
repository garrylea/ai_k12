import { useState, useRef, useCallback, useEffect } from 'react';
import {
  startDiscuss,
  startCardDiscuss,
  streamTutorEvents,
  getMessages,
  tutor,
  type MessageItem,
} from '@/services/api';
import { usePracticeStore } from '@/store/practiceStore';

export interface DiscussMessage {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  streaming?: boolean;
}

// 题目级（AnswerModal 内）：startDiscuss 记错题本 + 创建 mainline 对话，按题目文本缓存。
type QuestionOpts = {
  mode: 'question';
  cardId: number;
  questionText: string;
  subjectId: number;
  lessonId: number;
};

// 卡片级（CourseDetailPage 悬浮按钮，全屏页）：仅创建 mainline 对话（scope=cardId），
// 不记错题本（讨论的是知识而非一道题），按 cardId 缓存。
type CardOpts = {
  mode: 'card';
  cardId: number;
  subjectId: number;
  lessonId: number;
};

export type UseDiscussChatOpts = QuestionOpts | CardOpts;

// 种子消息：打开讨论自动发起，让 AI 给出首条苏格拉底引导。
// ⚠️ 必须避开 fallback.yaml 的 giveUpKeywords（不会/不懂/不知道/太难/放弃/算不出来/
// 想不出来/完全不会），否则首轮即触发兜底直接给答案，违反"苏格拉底不直接给答案"。
// 已知边角：若 questionText 本身含 giveUpKeyword（如应用题里出现"不知道"），首轮仍会
// 触发兜底--可接受（学生仍能得到帮助，只是非苏格拉底），MVP 不另做转义。
function buildSeed(opts: UseDiscussChatOpts): string {
  if (opts.mode === 'question') {
    return `我想请你带我思考这道题：\n\n${opts.questionText}\n\n请用提问的方式一步步启发我找到思路。`;
  }
  // 卡片级：scope 由 cardId->cardContent 注入 mainline prompt 限定，
  // 种子请 AI 用提问方式带学生梳理卡片知识（不直接讲授）。
  return '我想和你一起讨论这张卡片里的知识。请用提问的方式带我梳理其中的关键内容。';
}

// session 缓存键：题目级按题目文本，卡片级按 cardId 命名空间（避免与题目键冲突）。
function cacheKey(opts: UseDiscussChatOpts): string {
  return opts.mode === 'question' ? opts.questionText : `card:${opts.cardId}`;
}

/**
 * 讨论聊天 hook（题目级「让 AI 讲一讲」与卡片级「思辨答疑」共用）。
 * - 首次打开：创建 mainline 对话（题目级额外记错题本）-> 缓存 dialogueId
 *   -> 自动发种子消息，AI 流式返回首条苏格拉底引导。
 * - 重开（session 内已缓存 dialogueId）：拉取历史消息续接，不重复发种子。
 * - 消息状态为本地（不与辅线 chatStore 共享），避免冲突。
 */
export function useDiscussChat(opts: UseDiscussChatOpts) {
  const key = cacheKey(opts);
  const [messages, setMessages] = useState<DiscussMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogueIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seededRef = useRef(false);
  const setDiscussDialogue = usePracticeStore((s) => s.setDiscussDialogue);
  const cachedDialogueId = usePracticeStore((s) => s.discussDialogues[key]);

  const appendMessage = useCallback((m: DiscussMessage) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  const updateLastAssistant = useCallback((content: string, reasoning?: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      const copy = [...prev];
      copy[copy.length - 1] = { ...last, content, ...(reasoning !== undefined ? { reasoning } : {}) };
      return copy;
    });
  }, []);

  const appendLastAssistant = useCallback((opts: { content?: string; reasoning?: string }) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      const updated: DiscussMessage = { ...last };
      if (opts.content !== undefined) updated.content = last.content + opts.content;
      if (opts.reasoning !== undefined) updated.reasoning = (last.reasoning ?? '') + opts.reasoning;
      const copy = [...prev];
      copy[copy.length - 1] = updated;
      return copy;
    });
  }, []);

  const streamMessage = useCallback(async (dialogueId: string, message: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreaming(true);
    appendMessage({ role: 'user', content: message });
    appendMessage({ role: 'assistant', content: '', streaming: true });
    try {
      for await (const event of streamTutorEvents({ mode: 'mainline', dialogueId, message }, controller.signal)) {
        if (event.type === 'reasoning' && event.delta) {
          appendLastAssistant({ reasoning: event.delta });
        } else if (event.type === 'content' && event.delta !== undefined) {
          if (event.replace) updateLastAssistant(event.delta);
          else appendLastAssistant({ content: event.delta });
        } else if (event.type === 'error') {
          updateLastAssistant(`[生成中断] ${event.message ?? '请重试'}`);
        }
        // done: isStreaming 在 finally 复位
      }
    } catch (err) {
      // 用户点停止 -> 保留已生成内容，不降级 REST
      if (err instanceof Error && err.name === 'AbortError') return;
      // 流启动失败 -> 降级非流式 REST
      try {
        const res = await tutor({ mode: 'mainline', dialogueId, message });
        updateLastAssistant(res.message.content, res.reasoning);
      } catch {
        updateLastAssistant('[网络异常] 请稍后重试');
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsStreaming(false);
    }
  }, [appendMessage, appendLastAssistant, updateLastAssistant]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(async (content: string) => {
    if (isStreaming) return;
    if (!content.trim()) return;
    const dlgId = dialogueIdRef.current;
    if (!dlgId) return;
    setError(null);
    await streamMessage(dlgId, content);
  }, [isStreaming, streamMessage]);

  // 挂载即初始化：续接缓存对话 or 首开（创建对话 + 种子消息）
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      setError(null);
      if (cachedDialogueId) {
        // 续接：拉历史，不重发种子
        dialogueIdRef.current = cachedDialogueId;
        seededRef.current = true;
        setIsLoadingHistory(true);
        try {
          const items = await getMessages(Number(cachedDialogueId));
          if (cancelled) return;
          setMessages(
            items
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map((m: MessageItem) => ({
                id: m.id,
                role: m.role as 'user' | 'assistant',
                content: m.content,
                reasoning: m.reasoning ?? undefined,
              })),
          );
        } catch {
          // 拉取失败不阻断，学生仍可发新消息
        } finally {
          if (!cancelled) setIsLoadingHistory(false);
        }
        return;
      }
      // 首开：创建 mainline 对话（题目级额外记错题本）
      setIsStarting(true);
      try {
        let dialogueId: string;
        if (opts.mode === 'question') {
          const res = await startDiscuss({
            cardId: opts.cardId,
            lessonId: opts.lessonId,
            subjectId: opts.subjectId,
            questionText: opts.questionText,
          });
          dialogueId = res.dialogueId;
        } else {
          // 卡片级：find-or-create 该卡片的 mainline 对话（不入错题本，
          // 服务端按 student+card 复用，跨刷新/跨设备续接同一讨论线）。
          const res = await startCardDiscuss({
            cardId: opts.cardId,
            lessonId: opts.lessonId,
            subjectId: opts.subjectId,
          });
          dialogueId = res.dialogueId;
        }
        if (cancelled) return;
        dialogueIdRef.current = dialogueId;
        setDiscussDialogue(key, dialogueId);
      } catch {
        if (!cancelled) setError('打开讨论失败，请稍后重试');
        if (!cancelled) setIsStarting(false);
        return;
      }
      if (!cancelled) setIsStarting(false);
      // 自动发种子消息
      if (!cancelled && !seededRef.current) {
        seededRef.current = true;
        await streamMessage(dialogueIdRef.current!, buildSeed(opts));
      }
    };
    init();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
    // 仅挂载时初始化一次（抽屉/页按题/卡切换会 unmount/remount）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { messages, isStreaming, isLoadingHistory, isStarting, error, send, stop };
}
