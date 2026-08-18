import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Button, ConfirmDialog, Modal, toast } from '@/components/base';
import {
  createAdminDialogue,
  deleteAdminDialogue,
  listAdminChatMessages,
  listAdminDialogues,
  listAdminModels,
  streamAdminChat,
  type AdminModelItem,
} from '@/services/api';

interface DialogueItem {
  id: number;
  modelKey: string;
  title: string | null;
  updatedAt: string;
}

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

const PlusIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-4 h-4"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const TrashIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-3.5 h-3.5"
  >
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
);

const ChatIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-12 h-12 text-[var(--text-tertiary)]"
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const UserAvatar = () => (
  <div className="w-8 h-8 rounded-full bg-[var(--brand-500)] flex items-center justify-center flex-shrink-0">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  </div>
);

const AiAvatar = () => (
  <div className="w-8 h-8 rounded-full bg-[var(--bg-subtle)] border border-gray-100 flex items-center justify-center flex-shrink-0">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--brand-500)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
    </svg>
  </div>
);

const ThinkingDots = () => (
  <span className="inline-flex items-center gap-1 py-1" aria-label="正在思考">
    <span className="thinking-dot" />
    <span className="thinking-dot" />
    <span className="thinking-dot" />
  </span>
);

// Markdown + LaTeX (KaTeX) 渲染（复用辅线 AuxChatPanel 的渲染组合，纯本地组件无 stripTrailingJson）。
const Markdown = ({ children }: { children: string }) => (
  <div className="chat-prose break-words">
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkGfm]}
      rehypePlugins={[rehypeKatex]}
      components={{
        p: ({ children }) => <p className="leading-relaxed first:mt-0 last:mb-0 break-words">{children}</p>,
        ul: ({ children }) => <ul className="list-disc pl-5 my-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 my-1">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed my-0.5">{children}</li>,
        pre: ({ children }) => <pre className="my-1.5 p-2.5 rounded bg-black/5 overflow-x-auto text-[0.85em]">{children}</pre>,
        code: ({ className, children, ...props }) =>
          className?.includes('language-') ? (
            <code {...props}>{children}</code>
          ) : (
            <code className="px-1 py-0.5 rounded bg-black/5 font-mono text-[0.85em]" {...props}>{children}</code>
          ),
        h1: ({ children }) => <h1 className="text-base font-bold mt-2 mb-1 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="text-sm font-bold mt-2 mb-1 first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold mt-1.5 mb-0.5 first:mt-0">{children}</h3>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-[#E5E5E5] pl-2 my-1 text-[#86868B]">{children}</blockquote>,
        a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-[var(--brand-500)] underline">{children}</a>,
        table: ({ children }) => <table className="my-1 border-collapse">{children}</table>,
        th: ({ children }) => <th className="border border-[#E5E5E5] px-2 py-1 font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-[#E5E5E5] px-2 py-1">{children}</td>,
      }}
    >
      {children}
    </ReactMarkdown>
  </div>
);

const formatTime = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function AdminChatPage() {
  const [dialogues, setDialogues] = useState<DialogueItem[]>([]);
  const [models, setModels] = useState<AdminModelItem[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [input, setInput] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [selectedModelKey, setSelectedModelKey] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DialogueItem | null>(null);

  const accRef = useRef('');
  const assistantStartedRef = useRef(false);
  const streamingForRef = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [dlgList, modelList] = await Promise.all([listAdminDialogues(), listAdminModels()]);
        if (cancelled) return;
        setDialogues(dlgList);
        setModels(modelList);
      } catch (err: unknown) {
        if (!cancelled) toast('error', err instanceof Error ? err.message : '加载失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const enabledModels = models.filter((m) => m.isEnabled);
  const currentDialogue = dialogues.find((d) => d.id === currentId) ?? null;

  const openNew = () => {
    const first = enabledModels[0];
    setSelectedModelKey(first ? first.modelKey : '');
    setShowNew(true);
  };

  const handleSwitch = async (id: number) => {
    if (streaming) return;
    setCurrentId(id);
    setMessages([]);
    try {
      const list = await listAdminChatMessages(id);
      setMessages(list.map((m) => ({ role: m.role, content: m.content })));
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '加载消息失败');
    }
  };

  const handleCreate = async () => {
    if (!selectedModelKey) {
      toast('error', '请选择模型');
      return;
    }
    try {
      const { id } = await createAdminDialogue(selectedModelKey);
      setDialogues((prev) => [
        { id, modelKey: selectedModelKey, title: null, updatedAt: new Date().toISOString() },
        ...prev,
      ]);
      setCurrentId(id);
      setMessages([]);
      setShowNew(false);
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '创建会话失败');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    try {
      await deleteAdminDialogue(id);
      setDialogues((prev) => prev.filter((d) => d.id !== id));
      if (currentId === id) {
        setCurrentId(null);
        setMessages([]);
      }
      toast('success', '会话已删除');
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '删除失败');
    } finally {
      // 若删除的是当前正在流式的会话，中断正在进行的流
      if (streamingForRef.current === id) streamingForRef.current = null;
      setDeleteTarget(null);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !currentId || streaming) return;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setStreaming(true);
    accRef.current = '';
    assistantStartedRef.current = false;
    streamingForRef.current = currentId;
    try {
      for await (const e of streamAdminChat(currentId, text)) {
        // 流式期间当前会话被删除则中止
        if (streamingForRef.current !== currentId) break;
        if (e.type === 'message' && typeof e.delta === 'string') {
          // 流式 delta 追加到当前最后一条 assistant 消息
          accRef.current += e.delta;
          if (!assistantStartedRef.current) {
            assistantStartedRef.current = true;
            setMessages((prev) => [...prev, { role: 'assistant', content: accRef.current }]);
          } else {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, content: accRef.current };
              }
              return next;
            });
          }
        } else if (e.type === 'done') {
          break;
        } else if (e.type === 'error') {
          toast('error', e.message || '生成失败');
          setMessages((prev) => [...prev, { role: 'assistant', content: '(生成中断)' }]);
          break;
        }
      }
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '生成失败');
      setMessages((prev) => [...prev, { role: 'assistant', content: '(生成中断)' }]);
    } finally {
      setStreaming(false);
      accRef.current = '';
      assistantStartedRef.current = false;
      streamingForRef.current = null;
      try {
        // 刷新会话列表以更新 updatedAt
        setDialogues(await listAdminDialogues());
      } catch {
        // 静默：仅刷新列表失败不影响使用
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="h-[calc(100vh_-_3rem)] flex gap-4">
      {/* 左：会话列表 */}
      <div className="w-72 shrink-0 bg-white rounded-2xl border border-gray-200 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>会话</h2>
          <Button variant="primary" size="sm" icon={<PlusIcon />} onClick={openNew}>新建</Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {dialogues.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>暂无会话</p>
          ) : (
            dialogues.map((d) => (
              <div
                key={d.id}
                className={`group px-4 py-3 border-b border-gray-50 cursor-pointer hover:bg-gray-50 transition-colors ${currentId === d.id ? 'bg-blue-50/60' : ''}`}
                onClick={() => handleSwitch(d.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {d.title || '未命名会话'}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(d);
                    }}
                    className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--error)] hover:bg-gray-100 transition-colors opacity-0 group-hover:opacity-100"
                    title="删除会话"
                    aria-label="删除会话"
                  >
                    <TrashIcon />
                  </button>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-xs text-[var(--text-tertiary)]">{d.modelKey}</span>
                  <span className="text-xs text-[var(--text-tertiary)]">{formatTime(d.updatedAt)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 右：聊天窗 */}
      <div className="flex-1 bg-white rounded-2xl border border-gray-200 flex flex-col overflow-hidden">
        {!currentDialogue ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
            <ChatIcon />
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              选择左侧会话，或新建一个会话与 AI 对话
            </p>
          </div>
        ) : (
          <>
            <div className="px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
                  {currentDialogue.title || 'AI 助手'}
                </h2>
                <span className="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-blue-50" style={{ color: 'var(--brand-500)' }}>
                  {currentDialogue.modelKey}
                </span>
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>此聊天不受 K12 学习边界限制</p>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.map((m, idx) => {
                const isStreamingBubble = streaming && m.role === 'assistant' && idx === messages.length - 1;
                return (
                  <div key={idx} className={`flex items-start gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {m.role === 'assistant' && <AiAvatar />}
                    <div
                      className={`max-w-[78%] rounded-2xl text-sm overflow-hidden px-4 py-3 ${
                        m.role === 'user'
                          ? 'bg-[var(--brand-500)] text-white'
                          : 'bg-[var(--bg-subtle)] border border-gray-100'
                      }`}
                      style={m.role === 'user' ? undefined : { color: 'var(--text-primary)' }}
                    >
                      {m.role === 'assistant'
                        ? m.content
                          ? <Markdown>{m.content}</Markdown>
                          : isStreamingBubble
                            ? <ThinkingDots />
                            : null
                        : <span className="whitespace-pre-wrap break-words">{m.content}</span>}
                    </div>
                    {m.role === 'user' && <UserAvatar />}
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            <div className="shrink-0 px-4 py-3 border-t border-gray-100">
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={streaming}
                  placeholder="输入消息，Enter 发送，Shift+Enter 换行"
                  rows={1}
                  className="flex-1 resize-none max-h-32 min-h-[40px] px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--brand-500)] disabled:opacity-60"
                />
                <Button
                  variant="primary"
                  size="md"
                  loading={streaming}
                  disabled={!input.trim() || !currentId}
                  onClick={send}
                >
                  {streaming ? '生成中' : '发送'}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 新建会话 Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="新建会话">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>选择模型</label>
            <select
              value={selectedModelKey}
              onChange={(e) => setSelectedModelKey(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:border-[var(--brand-500)] outline-none"
            >
              {enabledModels.length === 0 && <option value="">无可用模型</option>}
              {enabledModels.map((m) => (
                <option key={m.modelKey} value={m.modelKey}>
                  {m.name}（{m.modelKey}）
                </option>
              ))}
            </select>
            {enabledModels.length === 0 && (
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>请先在「模型配置」中启用至少一个模型</p>
            )}
          </div>
          <div className="flex gap-3 justify-end pt-2 border-t border-gray-100">
            <Button variant="ghost" size="sm" onClick={() => setShowNew(false)}>取消</Button>
            <Button variant="primary" size="sm" disabled={!selectedModelKey} onClick={handleCreate}>创建</Button>
          </div>
        </div>
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除会话"
        message={`确定删除会话「${deleteTarget?.title || '未命名会话'}」？此操作不可恢复。`}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
