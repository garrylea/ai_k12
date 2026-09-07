import { useEffect, useRef, useState, useCallback } from 'react';
import getStroke from 'perfect-freehand';
import { useThemeStore } from '@/store/themeStore';
import { getDraft, setDraft, clearDraft, type Stroke } from './draft-store';

type Tool = 'pen' | 'eraser';

/**
 * perfect-freehand 轮廓 -> canvas 填充路径。
 * 2026-09-07 笔迹观感调优：size 减半（细）、thinning 降低（粗细更均匀）、
 * smoothing/streamline 调高（曲线与轨迹更平滑、去抖动）。stroke.size 存的是基础半径，
 * 实际线宽 ≈ size×2（即 PEN_BASE_SIZE×2）。
 */
function strokePath(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const outline = getStroke(stroke.points, {
    size: stroke.size * 2,
    thinning: 0.25,
    smoothing: 0.7,
    streamline: 0.7,
  });
  if (outline.length === 0) return;
  ctx.beginPath();
  outline.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fill();
}

/** 点到线段距离平方（避免开方） */
function distToSegmentSq(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const ex = x1 + t * dx - px;
  const ey = y1 + t * dy - py;
  return ex * ex + ey * ey;
}

/** 橡皮命中：点到某笔画折线的最近距离是否在阈值内 */
function hitStroke(stroke: Stroke, x: number, y: number): boolean {
  const threshold = stroke.size + 8;
  const pts = stroke.points;
  if (pts.length === 1) {
    const d = (pts[0].x - x) ** 2 + (pts[0].y - y) ** 2;
    return d <= threshold * threshold;
  }
  for (let i = 1; i < pts.length; i++) {
    if (distToSegmentSq(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= threshold * threshold) {
      return true;
    }
  }
  return false;
}

/** 笔宽基数（CSS px，半径语义）：stroke.size×2 = 实际线宽。原 3 → 1.5（6px→3px 细一倍） */
const PEN_BASE_SIZE = 1.5;
/** scroll-y 模式画板高 = 容器可视高 × 该系数（纵向滚动条由此产生） */
const SCROLL_Y_FACTOR = 1.6;

const PenIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19l7-7 3 3-7 7-3-3z" />
    <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
    <path d="M2 2l7.586 7.586" />
    <circle cx="11" cy="11" r="2" />
  </svg>
);

const EraserIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 20H7L3 16a1 1 0 0 1 0-1.4L13.6 4a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4L12 18" />
  </svg>
);

const TrashIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

export function DraftWhiteboard({
  questionId,
  scrollMode = 'fit',
  persist = true,
}: {
  questionId: string;
  scrollMode?: 'fit' | 'scroll-y';
  persist?: boolean;
}) {
  const [tool, setTool] = useState<Tool>('pen');
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  // 两指平移（仅 scroll-y 模式）：活动指针表（pointerId -> 该指针 clientY）+ 平移标志 + 上一帧质心 clientY
  const activePointersRef = useRef<Map<number, { y: number }>>(new Map());
  const panRef = useRef(false);
  const panLastYRef = useRef(0);
  const themeMode = useThemeStore((s) => s.mode);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = (getComputedStyle(canvas).getPropertyValue('--text-primary') || '#333').trim();
    for (const s of strokesRef.current) strokePath(ctx, s);
  }, []);

  // 尺寸：DPR 适配 + ResizeObserver。fit：canvas 贴合容器；scroll-y：画板高 = 容器高 × 1.6（纵向滚动）
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const board = boardRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(wrap.clientWidth));
      const h = Math.max(1, Math.round(wrap.clientHeight));
      if (scrollMode === 'scroll-y') {
        const boardH = Math.round(h * SCROLL_Y_FACTOR);
        if (board) board.style.height = `${boardH}px`;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(boardH * dpr);
      } else {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [redraw, scrollMode]);

  // 主题变化：笔迹颜色自适应（不存色值，重绘时读 CSS 变量）
  useEffect(() => { redraw(); }, [themeMode, redraw]);

  // 切题：persist 时加载该题草稿；persist=false 时清空本地笔迹（草稿不保存，切题即空）
  useEffect(() => {
    strokesRef.current = persist ? getDraft(questionId) : [];
    redraw();
  }, [questionId, persist, redraw]);

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pointerType === 'mouse' ? 0.5 : e.pressure || 0.5,
    };
  };

  const eraseAt = (x: number, y: number) => {
    const before = strokesRef.current.length;
    strokesRef.current = strokesRef.current.filter((s) => !hitStroke(s, x, y));
    if (strokesRef.current.length !== before) {
      if (persist) setDraft(questionId, strokesRef.current);
      redraw();
    }
  };

  // 平移质心 = 活动指针 clientY 均值（client 坐标，与滚动/手指位移一致）
  const meanActiveY = () => {
    const ptrs = activePointersRef.current;
    let sum = 0;
    for (const p of ptrs.values()) sum += p.y;
    return ptrs.size === 0 ? 0 : sum / ptrs.size;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // scroll-y：每根落到画布的新指针都先记录（含第二根）；两指齐下进入平移，打断进行中的单指笔迹
    if (scrollMode === 'scroll-y') {
      const wasPanning = panRef.current;
      const prevCount = activePointersRef.current.size;
      activePointersRef.current.set(e.pointerId, { y: e.clientY });
      if (!wasPanning && prevCount === 1 && activePointersRef.current.size === 2) {
        panRef.current = true;
        panLastYRef.current = meanActiveY();
        if (drawingRef.current) {
          // 取消进行中的单指笔画：只有刚按下未成形的单点笔迹才移除，已拖出的保留
          drawingRef.current = false;
          const strokes = strokesRef.current;
          const last = strokes[strokes.length - 1];
          if (last && last.points.length === 1) strokes.pop();
          redraw();
        }
        return;
      }
      if (panRef.current) return; // 平移中（第三指及以上）：仅记录，不再起笔
    }
    const p = pointFromEvent(e);
    if (tool === 'eraser') {
      eraseAt(p.x, p.y);
      return;
    }
    drawingRef.current = true;
    strokesRef.current.push({ points: [p], size: PEN_BASE_SIZE });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (panRef.current) {
      activePointersRef.current.set(e.pointerId, { y: e.clientY });
      const meanY = meanActiveY();
      const delta = meanY - panLastYRef.current;
      panLastYRef.current = meanY;
      // 内容跟随手指：wrap.scrollTop 实时读（边界由浏览器自动夹紧）
      const wrap = wrapRef.current;
      if (wrap) wrap.scrollTop -= delta;
      return;
    }
    const p = pointFromEvent(e);
    if (tool === 'eraser') {
      if (e.buttons === 0) return; // 未按下不擦
      eraseAt(p.x, p.y);
      return;
    }
    if (!drawingRef.current) return;
    const stroke = strokesRef.current[strokesRef.current.length - 1];
    stroke.points.push(p);
    redraw();
  };

  const endPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (scrollMode !== 'scroll-y') return;
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) panRef.current = false;
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    endPointer(e);
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (persist) setDraft(questionId, strokesRef.current);
  };

  // 系统打断（来电/手势接管）或捕获丢失：指针从表中移除；中断单指笔迹，不落盘
  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    endPointer(e);
    drawingRef.current = false;
  };
  const handleLostPointerCapture = (e: React.PointerEvent<HTMLCanvasElement>) => {
    endPointer(e);
  };

  const handleClear = () => {
    strokesRef.current = [];
    if (persist) clearDraft(questionId);
    redraw();
  };

  // 画布元素：两种模式共用一份 JSX（refs/handlers/样式相同），差异只在套的外层容器
  const canvasEl = (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ touchAction: 'none', cursor: tool === 'eraser' ? 'cell' : 'crosshair' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostPointerCapture}
      onPointerLeave={handlePointerUp}
    />
  );

  const toolBtn = (t: Tool, label: string, icon: React.ReactNode) => (
    <button
      onClick={() => setTool(t)}
      title={label}
      aria-label={label}
      aria-pressed={tool === t}
      className={`w-[38px] h-[38px] rounded-xl border flex items-center justify-center transition-colors ${
        tool === t
          ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-500)]'
          : 'border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)]'
      }`}
    >
      {icon}
    </button>
  );

  return (
    <div className="h-full flex flex-col">
      {/* 工具条 */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--bg-subtle)]">
        {toolBtn('pen', '手写笔', <PenIcon />)}
        {toolBtn('eraser', '橡皮', <EraserIcon />)}
        <div className="flex-1" />
        <button
          onClick={handleClear}
          title="清空草稿"
          aria-label="清空草稿"
          className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)] transition-colors"
        >
          <TrashIcon />
        </button>
      </div>
      {/* 手写画布：fit 直接贴容器；scroll-y 包定高画板 div，外层 overflow-y-auto（仅纵向可滚） */}
      {scrollMode === 'scroll-y' ? (
        <div ref={wrapRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div ref={boardRef} className="relative" style={{ width: '100%' }}>
            {canvasEl}
          </div>
        </div>
      ) : (
        <div ref={wrapRef} className="flex-1 min-h-0 relative">
          {canvasEl}
        </div>
      )}
    </div>
  );
}
