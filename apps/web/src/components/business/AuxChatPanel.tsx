import { useRef, useEffect, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

interface Props {
  isLoadingHistory?: boolean;
}

const UserAvatar = () => (
  <div className="w-8 h-8 rounded-full bg-[#FF6B00] flex items-center justify-center flex-shrink-0">
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

const AIAvatar = () => (
  <div className="w-8 h-8 rounded-full bg-[#F0F0F2] border border-[#E5E5E5] flex items-center justify-center flex-shrink-0">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#FF6B00"
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

// Markdown + LaTeX (KaTeX) rendering for assistant replies. math via $...$ / $$...$$.
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
        a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-[#FF6B00] underline">{children}</a>,
        table: ({ children }) => <table className="my-1 border-collapse">{children}</table>,
        th: ({ children }) => <th className="border border-[#E5E5E5] px-2 py-1 font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-[#E5E5E5] px-2 py-1">{children}</td>,
      }}
    >
      {children}
    </ReactMarkdown>
  </div>
);

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// Full-screen image preview: click an image in the chat to view it at its
// original aspect ratio (fit to viewport). Close via the X button, backdrop
// click, or Esc.
function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <img
        src={src}
        alt="图片预览"
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-xl"
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭"
        className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function ReasoningBlock({ reasoning, live }: { reasoning: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // The model (qwen3.7-max) emits reasoning_content with literal "\n" (backslash
  // + n, two chars) as line separators instead of real newlines. Normalize so
  // split/render work; no-op for records that already use real newlines.
  const normalized = reasoning.replace(/\\n/g, '\n');

  // Collapsed preview while streaming: show the CURRENT THINKING STAGE title.
  // The model's CoT marks section headers with a trailing colon (： or :), e.g.
  // "分析用户的问题：" / "解题思路通常包括：" / "草稿：". A header line is:
  //   - ends with ： or :
  //   - contains no sentence-internal punctuation (。！？) -- a long sentence
  //     that happens to end with ： (e.g. the model posing a question in the
  //     draft) is rejected
  //   - short (<= 24 chars)
  // Key-value lines like "年级：9年级。" end with 。 (not ：) so they're excluded
  // too. Pick the most recent header as the current stage; before the first
  // header arrives, fall back to the last non-empty line. Once streaming ends,
  // show a static 48-char head preview instead.
  const livePreview = (() => {
    const isHeader = (t: string) =>
      /[:：]$/.test(t) && !/[。！？]/.test(t) && t.length <= 24;
    const lines = normalized.split('\n');
    let stage = '';
    let last = '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      last = t;
      if (isHeader(t)) stage = t;
    }
    return stage || last;
  })();
  const preview = normalized.replace(/\s+/g, ' ').trim().slice(0, 48);

  // Auto-scroll the expanded view to the bottom as thinking streams in.
  useEffect(() => {
    if (open && live && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [reasoning, open, live]);

  return (
    <div className="mb-2 rounded-lg bg-white/70 border border-[#E5E5E5] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#86868B] hover:text-[#1D1D1F] transition"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="flex-shrink-0">{live ? '正在思考' : '思考过程'}</span>
        {live && (
          <svg viewBox="0 0 24 24" fill="none" className="w-3 h-3 flex-shrink-0 animate-spin text-[#FF6B00]">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        )}
        {!open && (live ? livePreview : preview) && (
          <span className="flex-1 truncate text-[#A0A0A5]">
            {live ? livePreview : `${preview}…`}
          </span>
        )}
        {!open && live && (
          <span className="flex-shrink-0 text-[#A0A0A5]">已思考 {normalized.length} 字</span>
        )}
      </button>
      {open && (
        <div
          ref={bodyRef}
          className="px-3 pb-2.5 pt-1.5 text-xs text-[#86868B] leading-relaxed whitespace-pre-wrap border-t border-[#E5E5E5] max-h-60 overflow-auto"
        >
          {normalized}
        </div>
      )}
    </div>
  );
}

export default function AuxChatPanel({ isLoadingHistory = false }: Props) {
  const { messages, isStreaming } = useChatStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4">
      {isLoadingHistory && messages.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-[#86868B]">
          加载中...
        </div>
      ) : (
        messages.map((m, idx) => {
          const hasImages = !!m.images && m.images.length > 0;
          const thinking = isStreaming && m.streaming && !m.content;
          // Assistant replies render as markdown+LaTeX; user messages stay plain text.
          const contentEl =
            m.role === 'assistant'
              ? m.content
                ? <Markdown>{m.content}</Markdown>
                : thinking ? <ThinkingDots /> : null
              : m.content;
          return (
            <div
              key={m.id ?? `optimistic-${idx}`}
              className={`flex items-start gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {m.role === 'assistant' && <AIAvatar />}
              <div
                className={`max-w-[70%] rounded-2xl text-sm overflow-hidden ${
                  m.role === 'user'
                    ? 'bg-[#FF6B00] text-white'
                    : 'bg-[#F9F9FB] text-[#1D1D1F] border border-[#E5E5E5]'
                } ${hasImages ? 'p-1.5' : 'px-4 py-3'}`}
              >
                {m.role === 'assistant' && m.reasoning && (
                  <ReasoningBlock
                    reasoning={m.reasoning}
                    live={isStreaming && idx === messages.length - 1}
                  />
                )}
                {hasImages && (
                  <div className={`flex flex-wrap gap-1 ${m.content ? 'mb-1' : ''}`}>
                    {m.images!.map((src, i) => (
                      <img
                        key={i}
                        src={src}
                        alt="已发送图片"
                        onClick={() => setPreviewSrc(src)}
                        className="max-w-[220px] max-h-[220px] rounded-md object-cover cursor-zoom-in hover:opacity-90 transition"
                      />
                    ))}
                  </div>
                )}
                {hasImages && m.content ? (
                  <div className="px-2.5 py-1.5">{contentEl}</div>
                ) : (
                  contentEl
                )}
              </div>
              {m.role === 'user' && <UserAvatar />}
            </div>
          );
        })
      )}
      <div ref={bottomRef} />
      {previewSrc && (
        <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
      )}
    </div>
  );
}
