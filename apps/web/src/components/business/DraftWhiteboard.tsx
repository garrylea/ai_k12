import { useEffect, useRef, useState, useCallback } from 'react';
import getStroke from 'perfect-freehand';
import { useThemeStore } from '@/store/themeStore';
import { getDraft, setDraft, clearDraft, type Stroke } from './draft-store';

type Tool = 'pen' | 'eraser';

/** perfect-freehand 轮廓 -> canvas 填充路径 */
function strokePath(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const outline = getStroke(stroke.points, {
    size: stroke.size * 2,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
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

const PEN_BASE_SIZE = 3;

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

export function DraftWhiteboard({ questionId }: { questionId: string }) {
  const [tool, setTool] = useState<Tool>('pen');
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const themeMode = useThemeStore((s) => s.mode);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = (getComputedStyle(canvas).getPropertyValue('--text-primary') || '#333').trim();
    for (const s of strokesRef.current) strokePath(ctx, s);
  }, []);

  // 尺寸：DPR 适配 + ResizeObserver
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(wrap.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(wrap.clientHeight * dpr));
      const ctx = canvas.getContext('2d');
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [redraw]);

  // 主题变化：笔迹颜色自适应（不存色值，重绘时读 CSS 变量）
  useEffect(() => { redraw(); }, [themeMode, redraw]);

  // 切题：加载新题草稿并重绘
  useEffect(() => {
    strokesRef.current = getDraft(questionId);
    redraw();
  }, [questionId, redraw]);

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
      setDraft(questionId, strokesRef.current);
      redraw();
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointFromEvent(e);
    if (tool === 'eraser') {
      eraseAt(p.x, p.y);
      return;
    }
    drawingRef.current = true;
    strokesRef.current.push({ points: [p], size: PEN_BASE_SIZE });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
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

  const handlePointerUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    setDraft(questionId, strokesRef.current);
  };

  const handleClear = () => {
    strokesRef.current = [];
    clearDraft(questionId);
    redraw();
  };

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
      {/* 手写画布 */}
      <div ref={wrapRef} className="flex-1 min-h-0 relative">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ touchAction: 'none', cursor: tool === 'eraser' ? 'cell' : 'crosshair' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        />
      </div>
    </div>
  );
}
