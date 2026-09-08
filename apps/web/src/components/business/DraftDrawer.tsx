// apps/web/src/components/business/DraftDrawer.tsx
// 训练轨答题页页面级草稿抽屉：右侧 absolute 滑出，内含 DraftWhiteboard（scroll-y 纵向可滚 + persist=false 不保存）。
// 草稿不持久化：key=questionId 切题即 remount 清空；关抽屉 unmount 即丢。仅手动关闭（X），不点外部收起。
// 宽度：左缘拖拽条鼠标连续调宽（40–85%）+ 右上「放大/缩小」两档快照（45↔70%）。
// 拖拽宽度模块级会话记忆：本会话内跨页、跨开关抽屉保持，刷新回默认 45%。
import { useCallback, useRef, useState } from 'react';
import { DraftWhiteboard } from './DraftWhiteboard';

interface Props {
  /** 当前题 q.n：作 DraftWhiteboard 的 key，切题即 remount 清空画布 */
  questionId: string;
  onClose: () => void;
}

/** 模块级会话记忆：拖拽/快照后的宽度在本会话内跨页、跨开关抽屉保持（刷新归默认） */
let lastWidthPct: number | null = null;

/** 宽度夹紧范围（相对定位容器 padding-box 宽的 %）：下限保白板书写空间，上限不盖尽左侧栏 */
const WIDTH_MIN = 40;
const WIDTH_MAX = 85;
const WIDTH_DEFAULT = 45;
/** 放大/缩小两档快照（%），与 expanded 按钮态对应 */
const WIDTH_SMALL = 45;
const WIDTH_LARGE = 70;

export function DraftDrawer({ questionId, onClose }: Props) {
  // 放大/缩小按钮态：仅作两档快照基准；拖拽连续调宽不更新它（按钮行为保持可预测）
  const [expanded, setExpanded] = useState(false);
  const [widthPct, setWidthPct] = useState<number>(() => lastWidthPct ?? WIDTH_DEFAULT);
  // 拖拽中关宽度过渡（实时跟随不滞后），落定后恢复过渡动画
  const [dragging, setDragging] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const widthPctRef = useRef(widthPct);
  // 拖拽起点快照：鼠标起始 clientX + 起始宽度 + 容器 padding-box 宽（% 的计算基准）
  const resizeStartRef = useRef<{ startX: number; startPct: number; baseW: number } | null>(null);

  const applyWidth = useCallback((pct: number) => {
    const clamped = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, pct));
    widthPctRef.current = clamped;
    setWidthPct(clamped);
  }, []);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const host = drawerRef.current?.offsetParent;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const cs = getComputedStyle(host);
    const baseW = rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
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

  const handleToggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    applyWidth(next ? WIDTH_LARGE : WIDTH_SMALL);
    lastWidthPct = widthPctRef.current;
  };

  return (
    <div
      ref={drawerRef}
      className={`absolute top-0 right-0 bottom-0 flex flex-col bg-[var(--learn-card-bg)] border-l border-[var(--bg-subtle)] transition-[width] duration-200 ${dragging ? 'transition-none select-none' : ''}`}
      style={{ boxShadow: 'var(--shadow-drawer)', width: `${widthPct}%` }}
      role="dialog"
      aria-label="草稿"
    >
      {/* 左缘拖拽条：鼠标按住左右拖动连续调宽（40–85%）；z-10 压过白板 canvas/贴图层（同为 absolute 且
          DOM 靠后者绘制在上，无 z 会盖住拖拽条吃掉指针事件，光标显示为画笔十字而非抓手）；
          10px 命中区 + 居中竖线握把，命中时 cursor-grab 抓手（功能性提示，非装饰） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整草稿宽度"
        draggable={false}
        className="absolute left-0 top-0 bottom-0 w-[10px] z-10 cursor-grab touch-none flex items-center justify-center group"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
      >
        <span className="w-[2px] h-14 rounded-full bg-[var(--bg-subtle)] group-hover:bg-[var(--text-tertiary)] transition-colors" />
      </div>

      {/* 头部：标题 + 放大/缩小 + 关闭（与 DiscussDrawer 同款） */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-[var(--bg-subtle)]">
        {/* 装饰性笔图标：旁有「草稿」文字标题，纯装饰故对读屏隐藏 */}
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0" aria-hidden="true">
          <path d="M12 19l7-7 3 3-7 7-3-3z" />
          <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
        </svg>
        <span className="text-sm font-bold text-[var(--text-primary)] flex-1">草稿</span>
        <button
          type="button"
          onClick={handleToggleExpand}
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
