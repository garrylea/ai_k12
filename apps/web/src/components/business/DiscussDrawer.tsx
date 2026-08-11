import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { useDiscussChat } from '@/hooks/useDiscussChat';
import { DiscussChat } from './DiscussChat';

// 题目级（AnswerModal 内抽屉）：放大铺满整个弹窗 w-full。
type QuestionProps = {
  mode: 'question';
  cardId: number;
  questionText: string;
  subjectId: number;
  lessonId: number;
  onClose: () => void;
};

// 卡片级（CourseDetailPage 内抽屉）：放大封顶 w-[70%]，不盖左侧阶段栏。
type CardProps = {
  mode: 'card';
  cardId: number;
  cardTitle?: string;
  subjectId: number;
  lessonId: number;
  onClose: () => void;
};

type Props = QuestionProps | CardProps;

export function DiscussDrawer(props: Props) {
  // useDiscussChat 按模式取不同入参（题目级需 questionText，卡片级不需）。
  const chat = useDiscussChat(
    props.mode === 'question'
      ? { mode: 'question', cardId: props.cardId, questionText: props.questionText, subjectId: props.subjectId, lessonId: props.lessonId }
      : { mode: 'card', cardId: props.cardId, subjectId: props.subjectId, lessonId: props.lessonId },
  );
  const [expanded, setExpanded] = useState(false);

  // 宽度：题目级 w-[55%]/w-full（放大铺满 AnswerModal）；卡片级 w-[45%]/w-[70%]（封顶，不盖左侧栏）。
  const widthClass = props.mode === 'question'
    ? expanded ? 'w-full' : 'w-[55%]'
    : expanded ? 'w-[70%]' : 'w-[45%]';
  const title = props.mode === 'question' ? 'AI 讲一讲' : '思辨答疑';
  const placeholder = props.mode === 'question' ? '说说你的想法或卡在哪里…' : '说说你的疑问或想法…';

  return (
    // 右侧抽屉：absolute 贴右覆盖父容器右部。实色背景（非半透明）保证 KaTeX 可读。
    // 仅手动关闭，不自动收起。父级需为 relative 定位容器。
    <div
      className={`absolute top-0 right-0 bottom-0 flex flex-col bg-[var(--learn-card-bg)] border-l border-[var(--bg-subtle)] transition-[width] duration-200 ${widthClass}`}
      style={{ boxShadow: 'var(--shadow-drawer)' }}
      role="dialog"
      aria-label={title}
    >
      {/* 头部：标题 + 放大/缩小 + 关闭 */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-[var(--bg-subtle)]">
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span className="text-sm font-bold text-[var(--text-primary)] flex-1">{title}</span>
        {/* 放大/缩小 */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
          title={expanded ? '缩小' : '放大'}
          aria-label={expanded ? '缩小' : '放大'}
        >
          {expanded ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <polyline points="9 3 3 3 3 9" />
              <polyline points="15 21 21 21 21 15" />
              <line x1="3" y1="3" x2="10" y2="10" />
              <line x1="21" y1="21" x2="14" y2="14" />
            </svg>
          )}
        </button>
        {/* 关闭 */}
        <button
          onClick={props.onClose}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
          title="收起"
          aria-label="收起"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* 上下文条：题目级显示当前题目，卡片级显示卡片标题（讨论时对照） */}
      <div className="shrink-0 px-4 py-2 border-b border-[var(--bg-subtle)] bg-[var(--bg-base)]">
        <div className="text-xs text-[var(--text-tertiary)] mb-0.5">
          {props.mode === 'question' ? '当前题目' : '当前卡片'}
        </div>
        <div className="text-xs text-[var(--text-secondary)] line-clamp-2">
          <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
            {props.mode === 'question' ? props.questionText : (props.cardTitle || 'AI 讨论')}
          </ReactMarkdown>
        </div>
      </div>

      {/* 消息区 + 输入区（共享组件） */}
      <DiscussChat
        messages={chat.messages}
        isStreaming={chat.isStreaming}
        isLoadingHistory={chat.isLoadingHistory}
        isStarting={chat.isStarting}
        error={chat.error}
        onSend={chat.send}
        onStop={chat.stop}
        onDelete={chat.deleteMsg}
        placeholder={placeholder}
      />
    </div>
  );
}
