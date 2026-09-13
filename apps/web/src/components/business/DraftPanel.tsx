// apps/web/src/components/business/DraftPanel.tsx
// 训练轨答题页的页面级草稿面板：与 QuestionRunner 并排占真实空间（不再是浮层覆盖答题区）——
// 左侧答题列被挤窄、右侧草稿列占位，中间一根分割条拖拽调宽（25–55%，双击复位默认 35%）。
// 面板返回 fragment，由调用页直接放进 `flex` 行：分割条与面板是两个并列的 flex 子项。
// 草稿持久化（PRD §7.12 随题存在）：store key 与 QuestionRunner 提交清理同键（`${draftKeyPrefix}-${q.n}`）——
// 收起再展开内容保留；提交时 QuestionRunner 的 clearDraft 一并清空；切题换 key 天然隔离。
// 宽度：模块级会话记忆（本会话内跨页、跨开关保持，刷新回默认）。
import { useCallback, useRef, useState } from 'react';
import { DraftWhiteboard } from './DraftWhiteboard';

interface Props {
  /** 当前题 q.n：与 draftKeyPrefix 拼成 DraftWhiteboard 的 store key，切题换 key 天然隔离 */
  questionId: string;
  /** 草稿键前缀（与同页 QuestionRunner 一致：tp / errp / exam-${sid}），提交后 clearDraft 同键清空 */
  draftKeyPrefix: string;
  onClose: () => void;
}

/** 模块级会话记忆：拖拽/双击后的宽度在本会话内跨页、跨开关保持（刷新归默认） */
let lastWidthPct: number | null = null;

/** 宽度夹紧范围（相对并排行宽的 %）：下限保答题列可读，上限保答题列不被挤没 */
const WIDTH_MIN = 25;
const WIDTH_MAX = 55;
const WIDTH_DEFAULT = 35;

export function DraftPanel({ questionId, draftKeyPrefix, onClose }: Props) {
  const [widthPct, setWidthPct] = useState<number>(() => lastWidthPct ?? WIDTH_DEFAULT);
  // 拖拽中关宽度过渡（实时跟随不滞后），落定后恢复过渡动画
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const widthPctRef = useRef(widthPct);
  // 拖拽起点快照：鼠标起始 clientX + 起始宽度 + 并排行宽（% 的计算基准）
  const resizeStartRef = useRef<{ startX: number; startPct: number; baseW: number } | null>(null);

  const applyWidth = useCallback((pct: number) => {
    const clamped = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, pct));
    widthPctRef.current = clamped;
    setWidthPct(clamped);
  }, []);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // 基准 = 面板所在「并排行」的内容宽（行无内边距，与 style 的 width: N% 同基准）
    const row = panelRef.current?.parentElement;
    if (!row) return;
    const baseW = row.getBoundingClientRect().width;
    if (baseW <= 0) return;
    resizeStartRef.current = { startX: e.clientX, startPct: widthPctRef.current, baseW };
    setDragging(true);
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rs = resizeStartRef.current;
    if (!rs || rs.baseW <= 0) return;
    applyWidth(rs.startPct + ((rs.startX - e.clientX) / rs.baseW) * 100);
  };

  const endResize = () => {
    if (!resizeStartRef.current) return; // pointerup 与 lostpointercapture 各触发一次，幂等收尾
    resizeStartRef.current = null;
    setDragging(false);
    lastWidthPct = widthPctRef.current; // 落定即写会话记忆
  };

  /** 双击分割条：回到默认宽度（拖拽中不响应，避免落定瞬间误触发） */
  const resetWidth = () => {
    if (resizeStartRef.current) return;
    applyWidth(WIDTH_DEFAULT);
    lastWidthPct = widthPctRef.current;
  };

  return (
    <>
      {/* 分割条：左右拖拽调宽（向左变窄、向右变宽），双击复位默认宽度。
          touch-none 防触屏把拖拽当滚动手势；本身不占视觉重量，只留一根居中握把线 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整草稿宽度（双击恢复默认）"
        draggable={false}
        className="w-[10px] shrink-0 cursor-grab touch-none select-none flex items-center justify-center group"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
        onDoubleClick={resetWidth}
      >
        <span className="w-[2px] h-14 rounded-full bg-[var(--bg-subtle)] group-hover:bg-[var(--text-tertiary)] transition-colors" />
      </div>

      {/* 草稿面板：占真实空间（与答题卡同款卡片），宽度由分割条控制 */}
      <div
        ref={panelRef}
        className={`shrink-0 min-w-0 flex flex-col rounded-xl overflow-hidden border border-[var(--learn-card-border)] shadow-sm transition-[width] duration-200 ${dragging ? 'transition-none select-none' : ''}`}
        style={{ backgroundColor: 'var(--learn-card-bg)', width: `${widthPct}%` }}
        role="dialog"
        aria-label="草稿"
      >
        {/* 头部：标题 + 收起（宽度靠中间分割条拖拽调整，故不再放放大/缩小按钮） */}
        <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-[var(--bg-subtle)]">
          {/* 装饰性笔图标：旁有「草稿」文字标题，纯装饰故对读屏隐藏 */}
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0" aria-hidden="true">
            <path d="M12 19l7-7 3 3-7 7-3-3z" />
            <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
          </svg>
          <span className="text-sm font-bold text-[var(--text-primary)] flex-1">草稿</span>
          <button
            type="button"
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

        {/* 画布：scroll-y + persist；key 与 QuestionRunner 草稿键同构——收起再开保留、提交清空、切题隔离 */}
        <div className="flex-1 min-h-0">
          <DraftWhiteboard
            key={`${draftKeyPrefix}-${questionId}`}
            questionId={`${draftKeyPrefix}-${questionId}`}
            scrollMode="scroll-y"
          />
        </div>
      </div>
    </>
  );
}

/** 草稿入口按钮（页面背景层右上角，absolute 定位由调用方包装；小尺寸低对比，不起眼） */
export function DraftIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
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
