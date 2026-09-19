import { useRef, useEffect, useState } from 'react';
import { useChatStore, type ChatError } from '@/store/chatStore';
import ReactMarkdown from 'react-markdown';
import { ImageLightbox } from '@/components/base';
import {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  MarkdownImg,
} from '@/components/markdown';

interface Props {
  isLoadingHistory?: boolean;
  onRetry?: () => void;  // P2: regenerate the last (errored / unanswered) turn
  onDelete?: (messageId: number) => void;  // delete a user message
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

// Inline error bubble shown when an assistant turn failed (P3). Displays the
// human-readable error reason. The retry button (P2) re-sends the last prompt.
const ErrorBubble = ({ error, onRetry }: { error: ChatError; onRetry?: () => void }) => (
  <div className="flex items-start gap-2">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#E5484D"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4 mt-0.5 flex-shrink-0"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
    <div className="flex flex-col gap-1">
      <span className="text-[0.7rem] font-medium text-[#E5484D]">生成失败</span>
      <span className="leading-relaxed text-[#1D1D1F]">{error.message}</span>
      {error.retryable && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="self-start mt-0.5 px-2.5 py-1 rounded-md bg-[#FF6B00] text-white text-xs hover:opacity-90 transition"
        >
          重试
        </button>
      )}
    </div>
  </div>
);

// Hide the structured-question JSON block (```json ... ```) from the rendered
// reply. The model appends it at the END of the formal answer for DB ingestion;
// the backend strips it via a `replace` event once the full block arrives, but
// during streaming the raw JSON would flash and widen the bubble.
//
// Precision (per user feedback): only strip the TRAILING ```json (the last one
// = the structured question appended after the answer), so a legitimate ```json
// code block in the answer body is preserved. This runs on the content stream
// only - the reasoning/thinking chain is a separate stream and is NOT touched.
// No-op for already-stripped history content (no fence present).
function stripTrailingJson(content: string): string {
  const idx = content.lastIndexOf('```json');
  if (idx < 0) return content;
  return content.slice(0, idx).replace(/\s+$/, '');
}

// qwen3.8-max's reasoning_content is unstructured prose: real-newline
// separated paragraphs whose lines almost all end with 。/., with NO markdown
// headings and NO colon-terminated title lines (the qwen3.7-era pattern the old
// heuristic matched no longer exists). The only real block boundary is the
// paragraph, so the "current thinking stage" is the last paragraph that has a
// completed leading label/clause:
//   - a `标签：` prefix with a short (<=12 char) label, or
//   - the first sentence/clause up to the first 。！？；, capped at 20 chars.
// A paragraph whose first sentence has not finished streaming yet yields no
// title, so the previous block's title stays put instead of flickering as the
// new paragraph grows. The trailing structured-question ```json block is cut
// first (it is not thinking).
function titleForParagraph(paragraph: string): string {
  const s = paragraph
    .replace(/^[-*•]\s+/, '')
    .replace(/^\(?\d+[.)、]\s*/, '')
    .replace(/^[（(]\d+[）)]\s*/, '');
  const label = s.match(/^([^\s：:。！？，、（(]{2,12})[：:]/);
  if (label) return label[1];
  const sentence = s.match(/^([^。！？；]*)[。！？；]/);
  if (!sentence) return ''; // first sentence not finished yet -> keep previous
  const clause = sentence[1].split(/[，、（(]/, 1)[0].trim().replace(/[：:]+$/, '');
  const text = clause || sentence[1].trim().replace(/[：:]+$/, '');
  return text.length > 20 ? text.slice(0, 20) : text;
}

function deriveStageTitle(reasoning: string): string {
  const paragraphs = stripTrailingJson(reasoning)
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
  let title = '';
  for (const p of paragraphs) {
    const t = titleForParagraph(p);
    if (t) title = t;
  }
  return title;
}

// Markdown + LaTeX (KaTeX) rendering for assistant replies. math via $...$ / $$...$$.
const Markdown = ({ children }: { children: string }) => {
  const display = stripTrailingJson(children);
  return (
    <div className="chat-prose break-words">
    <ReactMarkdown
      remarkPlugins={markdownRemarkPlugins}
      rehypePlugins={markdownRehypePlugins}
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
        a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-[#FF6B00] underline">{children}</a>,
        table: ({ children }) => <table className="my-1 border-collapse">{children}</table>,
        th: ({ children }) => <th className="border border-[#E5E5E5] px-2 py-1 font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-[#E5E5E5] px-2 py-1">{children}</td>,
        img: (props: { src?: string; alt?: string }) => (
          <MarkdownImg {...props} className="inline-block my-2 max-w-full max-h-[200px] object-contain rounded-lg align-middle" />
        ),
      }}
    >
      {display}
    </ReactMarkdown>
    </div>
  );
};

function ReasoningBlock({ reasoning, live }: { reasoning: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // The model (qwen3.8-max) emits reasoning_content with literal "\n" (backslash
  // + n, two chars) as line separators instead of real newlines. Normalize so
  // split/render work; no-op for records that already use real newlines.
  const normalized = reasoning.replace(/\\n/g, '\n');

  // Collapsed preview while streaming: the current paragraph's derived title
  // (paragraph-based, see deriveStageTitle), which changes only when a new
  // thinking paragraph starts instead of showing one ever-growing line. Once
  // streaming ends, show a static 48-char head preview instead.
  const livePreview = deriveStageTitle(normalized);
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
          <span className="flex-1 min-w-0 truncate text-[#A0A0A5]">
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

export default function AuxChatPanel({ isLoadingHistory = false, onRetry, onDelete }: Props) {
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
          const isError = !!m.error;
          const thinking = isStreaming && m.streaming && !m.content && !isError;
          // Error messages render a dedicated error bubble (P3), with any
          // already-streamed partial reply kept above it. Assistant replies
          // render as markdown+LaTeX; user messages stay plain text.
          const contentEl = isError
            ? (
              <div className="flex flex-col gap-2">
                {m.content ? <Markdown>{m.content}</Markdown> : null}
                <ErrorBubble error={m.error!} onRetry={onRetry} />
              </div>
            )
            : m.role === 'assistant'
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
                  isError
                    ? 'bg-[#FEF3F2] text-[#1D1D1F] border border-[#FDA29B]'
                    : m.role === 'user'
                      ? 'bg-[#FF6B00] text-white'
                      : 'bg-[#F9F9FB] text-[#1D1D1F] border border-[#E5E5E5]'
                } ${hasImages && !isError ? 'p-1.5' : 'px-4 py-3'} ${m.role === 'user' ? 'relative group' : ''}`}
              >
                {m.role === 'user' && onDelete && m.id && (
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
                  <ReasoningBlock
                    reasoning={m.reasoning}
                    live={isStreaming && idx === messages.length - 1}
                  />
                )}
                {!isError && hasImages && (
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
                {hasImages && m.content && !isError ? (
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
      {!isStreaming && !isLoadingHistory && messages.length > 0 &&
        messages[messages.length - 1].role === 'user' && onRetry && (
        <div className="flex justify-end items-center gap-2">
          <span className="text-xs text-[#86868B]">未收到回复</span>
          <button
            type="button"
            onClick={onRetry}
            className="px-3 py-1.5 rounded-md bg-[#FF6B00] text-white text-xs hover:opacity-90 transition"
          >
            重试
          </button>
        </div>
      )}
      <div ref={bottomRef} />
      {previewSrc && (
        <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
      )}
    </div>
  );
}
