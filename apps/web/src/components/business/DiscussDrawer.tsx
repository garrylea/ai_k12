import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  markdownComponents,
} from '@/components/markdown';
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

// 训练轨（答题页内抽屉）：同题目级（右抽屉，放大铺满），但不挂卡片上下文。
// questionId 用于按题锚定会话（scene=aux_training find-or-create），实现同题跨刷新续接。
type TrainingProps = {
  mode: 'training';
  questionText: string;
  // 按题锚定会话用（scene=aux_training find-or-create）；孤儿题等缺省时退化为每次新建。
  questionId?: number;
  onClose: () => void;
};

type Props = QuestionProps | CardProps | TrainingProps;

export function DiscussDrawer(props: Props) {
  // useDiscussChat 按模式取不同入参（题目级/训练轨需 questionText，卡片级不需）。
  const chat = useDiscussChat(
    props.mode === 'question'
      ? { mode: 'question', cardId: props.cardId, questionText: props.questionText, subjectId: props.subjectId, lessonId: props.lessonId }
      : props.mode === 'training'
        ? { mode: 'training', questionText: props.questionText, questionId: props.questionId }
        : { mode: 'card', cardId: props.cardId, subjectId: props.subjectId, lessonId: props.lessonId },
  );
  const [expanded, setExpanded] = useState(false);

  // 宽度：题目级/训练轨 w-[55%]/w-full（放大铺满答题区）；卡片级 w-[45%]/w-[70%]（封顶，不盖左侧栏）。
  const widthClass = props.mode === 'card'
    ? expanded ? 'w-[70%]' : 'w-[45%]'
    : expanded ? 'w-full' : 'w-[55%]';
  const title = props.mode === 'card' ? '思辨答疑' : 'AI 讲一讲';
  const placeholder = props.mode === 'card' ? '说说你的疑问或想法…' : '说说你的想法或卡在哪里…';

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

      {/* 上下文条：题目级/训练轨显示当前题目，卡片级显示卡片标题（讨论时对照） */}
      <div className="shrink-0 px-4 py-2 border-b border-[var(--bg-subtle)] bg-[var(--bg-base)]">
        <div className="text-xs text-[var(--text-tertiary)] mb-0.5">
          {props.mode === 'card' ? '当前卡片' : '当前题目'}
        </div>
        <div className="text-xs text-[var(--text-secondary)] line-clamp-2">
          <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
            {props.mode === 'card' ? (props.cardTitle || 'AI 讨论') : props.questionText}
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

/** 「让 AI 讲一讲」圆钮（题面右侧操作列）：AnswerModal 与训练轨答题页共用。 */
export function DiscussIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--info)] shadow-sm hover:bg-[var(--bg-subtle)] transition-colors"
      title="让 AI 讲一讲"
      aria-label="让 AI 讲一讲"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  );
}
