import { useState, useRef, useCallback, useEffect } from 'react';
import {
  startDiscuss,
  startCardDiscuss,
  streamTutorEvents,
  getMessages,
  deleteMessage,
  createConversation,
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

// 训练轨（答题页内抽屉）：不挂卡片/课时上下文，走辅线辅导链路——
// createConversation({track:'auxiliary', scene:'aux_training', questionId, questionText})
// + /ai/tutor/stream(mode auxiliary)。会话按题锚定续接；题面在建会话时作为一条
// assistant 题面锚消息写进历史（复用辅线拍照题“题目进历史、学生消息干净”的做法），
// AI 每轮靠对话历史带题面，学生消息不前缀。
type TrainingOpts = {
  mode: 'training';
  questionText: string;
  questionId?: number;
};

export type UseDiscussChatOpts = QuestionOpts | CardOpts | TrainingOpts;

// session 缓存键：题目级按题目文本，卡片级按 cardId 命名空间（避免与题目键冲突）。
function cacheKey(opts: UseDiscussChatOpts): string {
  if (opts.mode === 'question') return opts.questionText;
  // 训练轨按题锚定：优先用 questionId（同文本不同题不串会话），孤儿题退化用文本。
  if (opts.mode === 'training') return `training-q:${opts.questionId ?? opts.questionText}`;
  return `card:${opts.cardId}`;
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

  // 历史回放显示归一：仅 training 模式需要——
  // ① 隐藏「题面锚」assistant 消息（建会话时写入，内容=当前题面；与抽屉顶部「当前题目」栏重复）；
  // ② 剥离修复前旧会话里嵌在用户消息前的整段题面（`这道题目是：…我的问题：`），气泡只显示学生原话。
  const discussMode = opts.mode;
  const discussQuestionText = opts.mode === 'training' ? opts.questionText : '';
  const mapHistoryToDisplay = useCallback((items: MessageItem[]): DiscussMessage[] => {
    const stripped = items
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => {
        if (discussMode !== 'training') return true;
        if (m.role === 'assistant' && m.type === 'transcription' && m.content === discussQuestionText) return false;
        return true;
      })
      .map((m: MessageItem) => {
        let content = m.content;
        if (discussMode === 'training' && m.role === 'user') {
          const legacyPrefix = `这道题目是：\n\n${discussQuestionText}\n\n我的问题：`;
          if (content.startsWith(legacyPrefix)) content = content.slice(legacyPrefix.length);
        }
        return {
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content,
          reasoning: m.reasoning ?? undefined,
        };
      });
    return stripped;
  }, [discussMode, discussQuestionText]);

  // training 模式挂的是 auxiliary 对话，流式请求的 mode 必须与其 track 一致
  const tutorMode = opts.mode === 'training' ? 'auxiliary' : 'mainline';

  const streamMessage = useCallback(async (dialogueId: string, message: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreaming(true);
    appendMessage({ role: 'user', content: message });
    appendMessage({ role: 'assistant', content: '', streaming: true });
    try {
      for await (const event of streamTutorEvents({ mode: tutorMode, dialogueId, message }, controller.signal)) {
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
        const res = await tutor({ mode: tutorMode, dialogueId, message });
        updateLastAssistant(res.message.content, res.reasoning);
      } catch {
        updateLastAssistant('[网络异常] 请稍后重试');
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsStreaming(false);
    }
  }, [appendMessage, appendLastAssistant, updateLastAssistant, tutorMode]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(async (content: string) => {
    if (isStreaming) return;
    if (!content.trim()) return;
    const dlgId = dialogueIdRef.current;
    if (!dlgId) return;
    setError(null);
    // 题目级讨论（question 模式）：每条用户消息附带题目文本，确保 AI 聚焦当前题。
    // 卡片级与训练轨：消息即学生原话——卡片级上下文走服务端 loadContext->cardContent，
    // 训练轨题面在建会话时已作为题面锚消息写入历史（每轮靠对话历史带题面），无需重复。
    const message = opts.mode === 'question'
      ? `这道题目是：\n\n${opts.questionText}\n\n我的问题：${content}`
      : content;
    await streamMessage(dlgId, message);
  }, [isStreaming, streamMessage, opts]);

  /** 删除单条消息：前端立即移除 + 后台软删除 */
  const deleteMsg = useCallback(async (messageId: number) => {
    const dlgId = dialogueIdRef.current;
    if (!dlgId) return;
    // 前端先移除（乐观 UI）
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    try {
      await deleteMessage(Number(dlgId), messageId);
    } catch {
      // 删除失败静默
    }
  }, []);

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
          setMessages(mapHistoryToDisplay(items));
        } catch {
          // 拉取失败不阻断，学生仍可发新消息
        } finally {
          if (!cancelled) setIsLoadingHistory(false);
        }
        return;
      }
      // 首开：创建 mainline 对话（题目级额外记错题本）。
      // 服务端 find-or-create：即使缓存丢失，同一 student+card 始终返回同一个 dialogue。
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
        } else if (opts.mode === 'training') {
          // 训练讲一讲：走辅线会话 + scene=aux_training 按题锚定。
          // 服务端 (student, track, scene, question_id) find-or-create：同题跨刷新续接同一对话；
          // 仅新建时会把题面写成一条 assistant 题面锚消息（AI 靠历史带题面）。
          const conv = await createConversation({
            track: 'auxiliary',
            scene: 'aux_training',
            questionText: opts.questionText,
            ...(opts.questionId != null ? { questionId: opts.questionId } : {}),
          });
          dialogueId = String(conv.id);
        } else {
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

      // 检查该 dialogue 是否已有历史消息（服务器 find-or-create 可能返回已有对话）。
      if (!cancelled && !seededRef.current) {
        setIsLoadingHistory(true);
        try {
          const items = await getMessages(Number(dialogueIdRef.current!));
          if (cancelled) return;
          const existing = items.filter((m) => m.role === 'user' || m.role === 'assistant');
          if (existing.length > 0) {
            seededRef.current = true;
            setMessages(mapHistoryToDisplay(existing));
          }
        } catch {
          // 拉取失败不阻断，后续仍发种子消息
        } finally {
          if (!cancelled) setIsLoadingHistory(false);
        }
      }

      // 不再自动发种子消息，由用户主动发起第一条。
    };
    init();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
    // 仅挂载时初始化一次（抽屉/页按题/卡切换会 unmount/remount）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { messages, isStreaming, isLoadingHistory, isStarting, error, send, stop, deleteMsg };
}
