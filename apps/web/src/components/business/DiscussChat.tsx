import { useRef, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import type { DiscussMessage } from '@/hooks/useDiscussChat';

// ── 消息身份图标 ──
const AIcon = () => (
  <div className="w-6 h-6 rounded-full bg-[var(--bg-page)] border border-[var(--bg-subtle)] flex items-center justify-center shrink-0">
    <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  </div>
);

const UserIcon = () => (
  <div className="w-6 h-6 rounded-full bg-[var(--info)] flex items-center justify-center shrink-0" style={{ opacity: 0.75 }}>
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
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

const Markdown = ({ children }: { children: string }) => (
  <div className="chat-prose">
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkGfm]}
      rehypePlugins={[rehypeKatex]}
      components={{
        p: ({ children }) => <p className="leading-relaxed first:mt-0 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="list-disc pl-5 my-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 my-1">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed my-0.5">{children}</li>,
        code: ({ className, children, ...props }) =>
          className?.includes('language-') ? (
            <code {...props}>{children}</code>
          ) : (
            <code className="px-1 py-0.5 rounded bg-black/5 font-mono text-[0.85em]" {...props}>{children}</code>
          ),
      }}
    >
      {children}
    </ReactMarkdown>
  </div>
);

/** 简化版思考过程折叠块（辅线 ReasoningBlock 的轻量版：无实时阶段推断，仅折叠展示）。 */
function ReasoningBlock({ reasoning, live }: { reasoning: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const normalized = reasoning.replace(/\\n/g, '\n');
  const preview = normalized.replace(/\s+/g, ' ').trim().slice(0, 48);

  useEffect(() => {
    if (open && live && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [reasoning, open, live]);

  return (
    <div className="mb-2 rounded-lg bg-black/[0.04] border border-[var(--bg-subtle)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#9C8D80] hover:text-[#6B5D52] transition"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="flex-shrink-0">{live ? '正在思考' : '思考过程'}</span>
        {live && (
          <svg viewBox="0 0 24 24" fill="none" className="w-3 h-3 flex-shrink-0 animate-spin text-[var(--text-tertiary)]">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        )}
        {!open && preview && <span className="flex-1 truncate text-[#9C8D80] opacity-70">{preview}…</span>}
      </button>
      {open && (
        <div ref={bodyRef} className="px-3 pb-2.5 pt-1.5 text-xs text-[#9C8D80] leading-relaxed whitespace-pre-wrap border-t border-[var(--bg-subtle)] max-h-60 overflow-auto">
          {normalized}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ m, isLast, isStreaming, onDelete }: {
  m: DiscussMessage;
  isLast: boolean;
  isStreaming: boolean;
  onDelete?: (messageId: number) => void;
}) {
  const thinking = isStreaming && m.streaming && !m.content;
  const isUser = m.role === 'user';
  return (
    <div className={`flex items-start gap-2 group ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && <AIcon />}
      <div
        className={`max-w-[78%] rounded-2xl text-sm overflow-hidden ${
          isUser
            ? 'bg-[var(--info)] text-white'
            : 'bg-[var(--bg-page)] text-[#2A1F18] border border-[var(--bg-subtle)]'
        } px-4 py-3 relative`}
      >
        {isUser && onDelete && m.id && (
          <button
            onClick={() => onDelete(m.id!)}
            className="absolute top-1 right-1 w-5 h-5 rounded-full bg-white/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/30"
            title="删除"
            aria-label="删除消息"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        {m.role === 'assistant' && m.reasoning && (
          <ReasoningBlock reasoning={m.reasoning} live={isStreaming && isLast} />
        )}
        {m.role === 'assistant'
          ? m.content
            ? <Markdown>{m.content}</Markdown>
            : thinking ? <ThinkingDots /> : null
          : m.content}
      </div>
      {isUser && <UserIcon />}
    </div>
  );
}

interface DiscussChatProps {
  messages: DiscussMessage[];
  isStreaming: boolean;
  isLoadingHistory: boolean;
  isStarting: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onDelete?: (messageId: number) => void;
  placeholder?: string;
}

/**
 * 共享讨论聊天主体：消息列表 + 输入区（不含外壳）。
 * 父级需为 flex 纵向容器；本组件 flex-1 填满剩余空间。
 * 用于 DiscussDrawer（题目级抽屉）与 AiDiscussPage（卡片级全屏页）。
 */
export function DiscussChat({
  messages,
  isStreaming,
  isLoadingHistory,
  isStarting,
  error,
  onSend,
  onStop,
  onDelete,
  placeholder = '说说你的想法或卡在哪里…',
}: DiscussChatProps) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    onSend(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      {/* 消息区 */}
      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
        {error ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-tertiary)]">{error}</div>
        ) : isStarting ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--text-tertiary)]">
            <svg className="animate-spin text-[var(--text-tertiary)]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <span>正在打开讨论…</span>
          </div>
        ) : isLoadingHistory && messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-tertiary)]">加载中…</div>
        ) : (
          messages.map((m, idx) => (
            <MessageBubble key={m.id ?? `m-${idx}`} m={m} isLast={idx === messages.length - 1} isStreaming={isStreaming} onDelete={onDelete} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div className="shrink-0 p-3 border-t border-[var(--bg-subtle)]">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            className="flex-1 resize-none max-h-28 min-h-[40px] px-3 py-2 text-sm rounded-lg border border-[var(--bg-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--text-secondary)]"
          />
          {isStreaming ? (
            <button
              onClick={onStop}
              className="shrink-0 h-[40px] px-4 rounded-lg border border-[var(--bg-subtle)] text-[var(--text-tertiary)] text-sm hover:bg-[var(--bg-base)] transition-colors"
            >
              停止
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="shrink-0 h-[40px] px-4 rounded-lg bg-[var(--learn-btn-primary)] text-white text-sm disabled:opacity-40 hover:bg-[var(--learn-btn-primary-hover)] transition-colors"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </>
  );
}
