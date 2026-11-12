// apps/web/src/components/business/HandwritingPad.tsx
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { useThemeStore } from '@/store/themeStore';
import { RedoIcon, UndoIcon } from './handwriting/icons';

/**
 * 手写面板（原手写识别调研 demo 的 DemoSketchPad 泛化）：DraftWhiteboard 精简复制（笔/橡皮/撤销/重做/清空），
 * 固定 720×360，导出白底黑字 PNG（识别模型对白底黑字最稳，导出不随主题，spec §4.3）。
 * 有意不 import draft-store：无题目隔离需求，笔迹只存组件内。
 */

export interface DemoPoint { x: number; y: number; pressure: number }
export interface DemoStroke { points: DemoPoint[]; size: number }

const BOARD_W = 720;
const BOARD_H = 360;
/** 笔迹线宽（逻辑 px）：2026-10-12 用户要求在 1px 基础上加粗一倍，墨迹更接近真实笔迹观感 */
const INK_WIDTH = 2;
const ERASER_HIT_SLOP = 8;
/** 撤销栈上限：快照只存笔画数组（每笔几十个点），50 步足够写完一句诗又不至于无限涨 */
const MAX_HISTORY = 50;

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
  /** 识别成功后的提交式清空：连同撤销栈一起清掉（笔迹已变成文字，不该再撤回） */
  clear(): void;
}

const HandwritingPad = forwardRef<
  HandwritingPadHandle,
  { onStrokesChange?: (count: number) => void; /** 工具行右侧的额外内容（如调用方的切换图标），可选 */ toolbarRight?: ReactNode }
>(function HandwritingPad({ onStrokesChange, toolbarRight }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const strokesRef = useRef<DemoStroke[]>([]);
    const drawingRef = useRef(false);
    const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
    const toolRef = useRef(tool);
    toolRef.current = tool;
    const drawingStrokeRef = useRef<DemoStroke | null>(null);
    // 清空两段式确认：第一次点击进入待确认态（按钮变「确认清空」），3s 内再点才真清空，超时自动还原
    const [confirmingClear, setConfirmingClear] = useState(false);

    // 撤销/重做：存「变更前」的笔画数组快照。快照里的笔画对象落定后不再改动，
    // 因此浅拷贝数组即可；所有写操作一律换新数组（写时复制），绝不原地 push。
    const historyRef = useRef<DemoStroke[][]>([]);
    const futureRef = useRef<DemoStroke[][]>([]);
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);
    // 橡皮一次拖拽的起始快照：拖拽期间会连续擦掉多笔，抬手时只登记一步
    const eraseBeforeRef = useRef<DemoStroke[] | null>(null);

    useEffect(() => {
      if (!confirmingClear) return;
      const timer = window.setTimeout(() => setConfirmingClear(false), 3000);
      return () => window.clearTimeout(timer);
    }, [confirmingClear]);

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

    const syncHistoryFlags = useCallback(() => {
      setCanUndo(historyRef.current.length > 0);
      setCanRedo(futureRef.current.length > 0);
    }, []);

    const applyStrokes = useCallback((next: DemoStroke[]) => {
      strokesRef.current = next;
      notifyCount();
      redraw();
    }, [notifyCount, redraw]);

    /** 登记一步历史（传入变更前的快照），任何新动作都会作废重做栈 */
    const recordHistory = useCallback((before: DemoStroke[]) => {
      historyRef.current.push(before);
      if (historyRef.current.length > MAX_HISTORY) historyRef.current.shift();
      futureRef.current = [];
      syncHistoryFlags();
    }, [syncHistoryFlags]);

    const undo = useCallback(() => {
      // 手势进行中不响应：半截笔迹/橡皮拖拽会让快照错位
      if (drawingRef.current || eraseBeforeRef.current) return;
      const prev = historyRef.current.pop();
      if (!prev) return;
      futureRef.current.push(strokesRef.current);
      applyStrokes(prev);
      syncHistoryFlags();
    }, [applyStrokes, syncHistoryFlags]);

    const redo = useCallback(() => {
      if (drawingRef.current || eraseBeforeRef.current) return;
      const next = futureRef.current.pop();
      if (!next) return;
      historyRef.current.push(strokesRef.current);
      applyStrokes(next);
      syncHistoryFlags();
    }, [applyStrokes, syncHistoryFlags]);

    // 快捷键：p → 笔、e → 橡皮、Ctrl/Cmd+Z → 撤销、Ctrl/Cmd+Shift+Z / Ctrl+Y → 重做。
    // 焦点在输入类元素上时全部放行（让浏览器原生撤销输入框里的文字，也不干扰打字/IME 组字）
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.defaultPrevented) return;
        const el = e.target as HTMLElement | null;
        // target 可能是非 Element（如 window），closest 仅在 Element 上可用
        if (el && typeof el.closest === 'function' && el.closest('input, textarea, select, [contenteditable]')) return;
        const key = e.key.toLowerCase();
        if (e.metaKey || e.ctrlKey) {
          if (e.altKey) return;
          if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
          if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); }
          return;
        }
        if (e.altKey) return;
        if (key === 'p') setTool('pen');
        else if (key === 'e') setTool('eraser');
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [undo, redo]);

    const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): DemoPoint => {
      const rect = e.currentTarget.getBoundingClientRect();
      // 画布 CSS 宽度随容器自适应（≤720），书写坐标按「逻辑坐标/实际显示宽」等比换算；
      // jsdom rect 宽为 0，退化为 1（测试坐标即逻辑坐标）。
      const scale = rect.width > 0 ? BOARD_W / rect.width : 1;
      return {
        x: (e.clientX - rect.left) * scale,
        y: (e.clientY - rect.top) * scale,
        pressure: e.pointerType === 'mouse' ? 0.5 : e.pressure || 0.5,
      };
    };

    const eraseAt = (x: number, y: number) => {
      const prev = strokesRef.current;
      const next = prev.filter((s) => !hitStroke(s, x, y, s.size + ERASER_HIT_SLOP));
      // 没擦到东西就保持原数组引用（抬手时据此判断这次拖拽是否算一步历史）
      if (next.length === prev.length) return;
      applyStrokes(next);
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const p = pointFromEvent(e);
      if (toolRef.current === 'eraser') {
        eraseBeforeRef.current = strokesRef.current;
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
      if (drawingRef.current) {
        drawingRef.current = false;
        const stroke = drawingStrokeRef.current;
        drawingStrokeRef.current = null;
        if (stroke) {
          recordHistory(strokesRef.current);
          strokesRef.current = [...strokesRef.current, stroke];
          notifyCount();
        }
        redraw();
        return;
      }
      // 橡皮拖拽结束：一次拖拽擦掉 N 笔也只算一步撤销
      const before = eraseBeforeRef.current;
      eraseBeforeRef.current = null;
      if (before && before !== strokesRef.current) recordHistory(before);
    };

    /** 工具栏「清空」：可撤销（与识别后的提交式 clear 不同） */
    const clearWithUndo = () => {
      recordHistory(strokesRef.current);
      applyStrokes([]);
    };

    useImperativeHandle(ref, () => ({
      exportImage(): string | null {
        const strokes = strokesRef.current;
        if (strokes.length === 0) return null;
        const off = document.createElement('canvas');
        // 线宽降到 1px 后学生可写更小的字；导出倍数相应提到 4（2880×1440），
        // 保证小字在送模型的图里仍有足够像素密度，识别率不因写小字而掉。
        const scale = 4;
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
        // 识别成功后调用：笔迹已变成输入框里的文字，历史一并作废（否则「撤销」会让残影回来、诱发重复追加）
        strokesRef.current = [];
        historyRef.current = [];
        futureRef.current = [];
        applyStrokes([]);
        syncHistoryFlags();
      },
    }));

    return (
      <div className="block w-full max-w-[720px] rounded-[var(--radius-card)] border border-[var(--bg-subtle)] bg-white p-2">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            title="笔（快捷键 P）"
            onClick={() => setTool('pen')}
            className={`rounded-[var(--radius-button)] px-3 py-1 text-sm ${tool === 'pen' ? 'bg-[var(--brand-600)] text-white' : 'bg-[var(--bg-subtle)] text-[var(--text-primary)]'}`}
          >
            笔
          </button>
          <button
            type="button"
            title="橡皮（快捷键 E）"
            onClick={() => setTool('eraser')}
            className={`rounded-[var(--radius-button)] px-3 py-1 text-sm ${tool === 'eraser' ? 'bg-[var(--brand-600)] text-white' : 'bg-[var(--bg-subtle)] text-[var(--text-primary)]'}`}
          >
            橡皮
          </button>
          <button
            type="button"
            title={confirmingClear ? '再点一次确认清空全部笔迹' : '清空'}
            onClick={() => {
              if (strokesRef.current.length === 0) return;
              if (!confirmingClear) {
                setConfirmingClear(true);
                return;
              }
              setConfirmingClear(false);
              clearWithUndo();
            }}
            className={`rounded-[var(--radius-button)] px-3 py-1 text-sm ${confirmingClear ? 'bg-[var(--error)] text-white' : 'bg-[var(--bg-subtle)] text-[var(--text-primary)]'}`}
          >
            {confirmingClear ? '确认清空' : '清空'}
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              title="撤销（Ctrl+Z）"
              aria-label="撤销（Ctrl+Z）"
              onClick={undo}
              disabled={!canUndo}
              className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] bg-[var(--bg-subtle)] text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <UndoIcon />
            </button>
            <button
              type="button"
              title="重做（Ctrl+Shift+Z）"
              aria-label="重做（Ctrl+Shift+Z）"
              onClick={redo}
              disabled={!canRedo}
              className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] bg-[var(--bg-subtle)] text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RedoIcon />
            </button>
            {toolbarRight != null && <div className="flex items-center gap-2">{toolbarRight}</div>}
          </div>
        </div>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: 'auto', aspectRatio: '720 / 360', touchAction: 'none' }}
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
