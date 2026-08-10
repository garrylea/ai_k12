import { useRef, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import type { DiscussMessage } from '@/hooks/useDiscussChat';

// ── 呈现原语（与 AuxChatPanel 同风格；自包含，不引入辅线 chatStore）──
// 由 DiscussDrawer（题目级抽屉）与 AiDiscussPage（卡片级全屏页）共享。

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
    <div className="mb-2 rounded-lg bg-[var(--bg-base)] border border-[var(--bg-subtle)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="flex-shrink-0">{live ? '正在思考' : '思考过程'}</span>
        {live && (
          <svg viewBox="0 0 24 24" fill="none" className="w-3 h-3 flex-shrink-0 animate-spin text-[var(--brand-500)]">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        )}
        {!open && preview && <span className="flex-1 truncate text-[var(--text-tertiary)] opacity-70">{preview}…</span>}
      </button>
      {open && (
        <div ref={bodyRef} className="px-3 pb-2.5 pt-1.5 text-xs text-[var(--text-tertiary)] leading-relaxed whitespace-pre-wrap border-t border-[var(--bg-subtle)] max-h-60 overflow-auto">
          {normalized}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ m, isLast, isStreaming }: { m: DiscussMessage; isLast: boolean; isStreaming: boolean }) {
  const thinking = isStreaming && m.streaming && !m.content;
  return (
    <div className={`flex items-start gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[78%] rounded-2xl text-sm overflow-hidden ${
          m.role === 'user'
            ? 'bg-[var(--brand-500)] text-white'
            : 'bg-[var(--bg-base)] text-[var(--text-primary)] border border-[var(--bg-subtle)]'
        } px-4 py-3`}
      >
        {m.role === 'assistant' && m.reasoning && (
          <ReasoningBlock reasoning={m.reasoning} live={isStreaming && isLast} />
        )}
        {m.role === 'assistant'
          ? m.content
            ? <Markdown>{m.content}</Markdown>
            : thinking ? <ThinkingDots /> : null
          : m.content}
      </div>
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
            <svg className="animate-spin text-[var(--brand-500)]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <span>正在打开讨论…</span>
          </div>
        ) : isLoadingHistory && messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-tertiary)]">加载中…</div>
        ) : (
          messages.map((m, idx) => (
            <MessageBubble key={m.id ?? `m-${idx}`} m={m} isLast={idx === messages.length - 1} isStreaming={isStreaming} />
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
            className="flex-1 resize-none max-h-28 min-h-[40px] px-3 py-2 text-sm rounded-lg border border-[var(--bg-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--brand-500)]"
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
              className="shrink-0 h-[40px] px-4 rounded-lg bg-[var(--brand-500)] text-white text-sm disabled:opacity-40 hover:bg-[var(--brand-600)] transition-colors"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </>
  );
}
