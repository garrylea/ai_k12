// apps/web/src/components/business/HandwritingPad.tsx
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useThemeStore } from '@/store/themeStore';

/**
 * 手写面板（原手写识别调研 demo 的 DemoSketchPad 泛化）：DraftWhiteboard 精简复制（笔/橡皮/清空），
 * 固定 720×360，导出白底黑字 PNG（识别模型对白底黑字最稳，导出不随主题，spec §4.3）。
 * 有意不 import draft-store：无题目隔离需求，笔迹只存组件内。
 */

export interface DemoPoint { x: number; y: number; pressure: number }
export interface DemoStroke { points: DemoPoint[]; size: number }

const BOARD_W = 720;
const BOARD_H = 360;
/** 导出线宽（CSS px）：白板原 2px 偏细，汉字识别需笔画清晰（spec §4.3） */
const INK_WIDTH = 3;
const ERASER_HIT_SLOP = 8;

/** 二次贝塞尔平滑渲染（逻辑同 DraftWhiteboard.strokePath，去掉 center 标记分支） */
function strokePath(ctx: CanvasRenderingContext2D, stroke: DemoStroke): void {
  const pts = stroke.points;
  if (pts.length === 0) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = stroke.size;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  ctx.stroke();
}

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

function hitStroke(stroke: DemoStroke, x: number, y: number, threshold: number): boolean {
  const pts = stroke.points;
  if (pts.length === 1) {
    return (pts[0].x - x) ** 2 + (pts[0].y - y) ** 2 <= threshold * threshold;
  }
  for (let i = 1; i < pts.length; i++) {
    if (distToSegmentSq(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= threshold * threshold) {
      return true;
    }
  }
  return false;
}

export interface HandwritingPadHandle {
  exportImage(): string | null;
  clear(): void;
}

const HandwritingPad = forwardRef<HandwritingPadHandle, { onStrokesChange?: (count: number) => void }>(
  function HandwritingPad({ onStrokesChange }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const strokesRef = useRef<DemoStroke[]>([]);
    const drawingRef = useRef(false);
    const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
    const toolRef = useRef(tool);
    toolRef.current = tool;
    const drawingStrokeRef = useRef<DemoStroke | null>(null);

    const themeMode = useThemeStore((s) => s.mode);

    const redraw = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, BOARD_W, BOARD_H);
      // 屏显笔迹颜色随主题（不存色值，重绘时读 CSS 变量，同 DraftWhiteboard）
      const ink = (getComputedStyle(canvas).getPropertyValue('--text-primary') || '#333').trim();
      ctx.strokeStyle = ink;
      ctx.fillStyle = ink;
      for (const s of strokesRef.current) strokePath(ctx, s);
      if (drawingStrokeRef.current) strokePath(ctx, drawingStrokeRef.current);
    }, []);

    // 主题变化：笔迹颜色自适应
    useEffect(() => { redraw(); }, [themeMode, redraw]);

    // 固定尺寸画布：一次设置 dpr 缩放（720×360 逻辑 px）
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = BOARD_W * dpr;
      canvas.height = BOARD_H * dpr;
      redraw();
    }, [redraw]);

    const notifyCount = useCallback(() => {
      onStrokesChange?.(strokesRef.current.length);
    }, [onStrokesChange]);

    // 初始笔画数也要通知（页面据此初始化按钮禁用态）
    useEffect(() => {
      notifyCount();
    }, [notifyCount]);

    const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): DemoPoint => {
      const rect = e.currentTarget.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        pressure: e.pointerType === 'mouse' ? 0.5 : e.pressure || 0.5,
      };
    };

    const eraseAt = (x: number, y: number) => {
      const before = strokesRef.current.length;
      strokesRef.current = strokesRef.current.filter((s) => !hitStroke(s, x, y, s.size + ERASER_HIT_SLOP));
      if (strokesRef.current.length !== before) {
        notifyCount();
        redraw();
      }
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const p = pointFromEvent(e);
      if (toolRef.current === 'eraser') {
        eraseAt(p.x, p.y);
        return;
      }
      drawingRef.current = true;
      drawingStrokeRef.current = { points: [p], size: INK_WIDTH };
      redraw();
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const p = pointFromEvent(e);
      if (toolRef.current === 'eraser') {
        if (e.buttons) eraseAt(p.x, p.y);
        return;
      }
      if (!drawingRef.current || !drawingStrokeRef.current) return;
      drawingStrokeRef.current.points.push(p);
      redraw();
    };

    const handlePointerUp = () => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      if (drawingStrokeRef.current) {
        strokesRef.current.push(drawingStrokeRef.current);
        drawingStrokeRef.current = null;
        notifyCount();
      }
      redraw();
    };

    useImperativeHandle(ref, () => ({
      exportImage(): string | null {
        const strokes = strokesRef.current;
        if (strokes.length === 0) return null;
        const off = document.createElement('canvas');
        const scale = 2; // 导出 1440×720，给模型足够分辨率
        off.width = BOARD_W * scale;
        off.height = BOARD_H * scale;
        const ctx = off.getContext('2d');
        if (!ctx) return null;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, off.width, off.height);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.strokeStyle = '#111827';
        ctx.fillStyle = '#111827';
        for (const s of strokes) strokePath(ctx, s);
        return off.toDataURL('image/png');
      },
      clear(): void {
        strokesRef.current = [];
        notifyCount();
        redraw();
      },
    }));

    return (
      <div className="inline-block rounded-[var(--radius-card)] border border-[var(--bg-subtle)] bg-white p-2">
        <div className="mb-2 flex gap-2">
          <button
            type="button"
            title="笔"
            onClick={() => setTool('pen')}
            className={`rounded-[var(--radius-button)] px-3 py-1 text-sm ${tool === 'pen' ? 'bg-[var(--brand-600)] text-white' : 'bg-[var(--bg-subtle)] text-[var(--text-primary)]'}`}
          >
            笔
          </button>
          <button
            type="button"
            title="橡皮"
            onClick={() => setTool('eraser')}
            className={`rounded-[var(--radius-button)] px-3 py-1 text-sm ${tool === 'eraser' ? 'bg-[var(--brand-600)] text-white' : 'bg-[var(--bg-subtle)] text-[var(--text-primary)]'}`}
          >
            橡皮
          </button>
          <button
            type="button"
            title="清空"
            onClick={() => {
              strokesRef.current = [];
              notifyCount();
              redraw();
            }}
            className="rounded-[var(--radius-button)] bg-[var(--bg-subtle)] px-3 py-1 text-sm text-[var(--text-primary)]"
          >
            清空
          </button>
        </div>
        <canvas
          ref={canvasRef}
          style={{ width: BOARD_W, height: BOARD_H, touchAction: 'none' }}
          className="block rounded-[var(--radius-button)] border border-[var(--bg-subtle)] bg-white"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>
    );
  },
);

export default HandwritingPad;
