// apps/web/src/components/business/DraftDrawer.tsx
// 训练轨答题页页面级草稿抽屉：右侧 absolute 滑出，内含 DraftWhiteboard（scroll-y 纵向可滚 + persist=false 不保存）。
// 草稿不持久化：key=questionId 切题即 remount 清空；关抽屉 unmount 即丢。仅手动关闭（X），不点外部收起。
import { useState } from 'react';
import { DraftWhiteboard } from './DraftWhiteboard';

interface Props {
  /** 当前题 q.n：作 DraftWhiteboard 的 key，切题即 remount 清空画布 */
  questionId: string;
  onClose: () => void;
}

export function DraftDrawer({ questionId, onClose }: Props) {
  const [expanded, setExpanded] = useState(false);
  // 宽度两档：45% ↔ 70%（不盖左侧栏）；过渡与 DiscussDrawer 一致
  const widthClass = expanded ? 'w-[70%]' : 'w-[45%]';

  return (
    <div
      className={`absolute top-0 right-0 bottom-0 flex flex-col bg-[var(--learn-card-bg)] border-l border-[var(--bg-subtle)] transition-[width] duration-200 ${widthClass}`}
      style={{ boxShadow: 'var(--shadow-drawer)' }}
      role="dialog"
      aria-label="草稿"
    >
      {/* 头部：标题 + 放大/缩小 + 关闭（与 DiscussDrawer 同款） */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-[var(--bg-subtle)]">
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0">
          <path d="M12 19l7-7 3 3-7 7-3-3z" />
          <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
        </svg>
        <span className="text-sm font-bold text-[var(--text-primary)] flex-1">草稿</span>
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
        <button
          onClick={onClose}
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

      {/* 画布：scroll-y + persist=false；key=questionId 切题即 remount 清空 */}
      <div className="flex-1 min-h-0">
        <DraftWhiteboard key={questionId} questionId={questionId} scrollMode="scroll-y" persist={false} />
      </div>
    </div>
  );
}

/** 草稿入口按钮（页面背景层右上角，absolute 定位由调用方包装；小尺寸低对比，不起眼） */
export function DraftIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-8 h-8 rounded-lg border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
      title="草稿"
      aria-label="草稿"
    >
      {/* 笔 + 纸（线性 SVG，草稿入口语义；与 DraftWhiteboard 内部 PenIcon 略作区分） */}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    </button>
  );
}
