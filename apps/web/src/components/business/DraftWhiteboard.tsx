import { useEffect, useRef, useState, useCallback } from 'react';
import { useThemeStore } from '@/store/themeStore';
import {
  getDraft, setDraft, clearDraft, getDraftImages, setDraftImages, type Stroke, type DraftImage,
} from './draft-store';
import { DraftImageLayer } from './DraftImageLayer';
import { fileToDraftImage, isEditableTarget } from './draft-image-utils';

type Tool = 'pen' | 'eraser' | 'move';

/** 笔迹线宽（CSS px）：恒定线宽细线（钢笔感），无 thinning 粗细起伏 */
const INK_WIDTH = 2;

/**
 * 单条笔画平滑渲染（取代 perfect-freehand 填充轮廓画法）：
 * - 统一细线宽 + 圆头圆角（lineCap/lineJoin round），细且均匀；
 * - 用「顶点为控制点、相邻顶点中点为起止」的二次贝塞尔段串成连续曲线（C1 连续），
 *   曲线天然穿过相邻点中点 = 渲染期低通（抑制手抖高频抖动）；
 * - 输入侧不做 EWMA 前向平滑（之前 streamline 让笔尖滞后），最新采样点直接落笔 →
 *   渲染零跟手延迟。stroke.size 即 INK_WIDTH（也作橡皮命中阈值基数）。
 */
function strokePath(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const pts = stroke.points;
  if (pts.length === 0) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = stroke.size;
  if (pts.length === 1) {
    // 单点（点一下）：画实心圆点
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

const MoveIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="5 9 2 12 5 15" />
    <polyline points="9 5 12 2 15 5" />
    <polyline points="15 19 12 22 9 19" />
    <polyline points="19 9 22 12 19 15" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <line x1="12" y1="2" x2="12" y2="22" />
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

  // 切题竞态防护：在途图片解码（FileReader/Image，几百 ms）期间切题，放弃插入避免污染新题视图/覆写旧题 store
  const questionIdRef = useRef(questionId);
  useEffect(() => { questionIdRef.current = questionId; }, [questionId]);

  // 贴图：React state 渲染 + ref 镜像（异步插入/连续更新不拿旧闭包）；persist 时同步落 draft-store
  const [images, setImages] = useState<DraftImage[]>([]);
  const imagesRef = useRef<DraftImage[]>([]);
  const updateImages = useCallback((updater: (prev: DraftImage[]) => DraftImage[]) => {
    const next = updater(imagesRef.current);
    imagesRef.current = next;
    setImages(next);
    if (persist) setDraftImages(questionId, next);
  }, [persist, questionId]);

  // 粘贴/拖入入口：可视区中央落点，多张级联偏移 16px 防完全重叠
  const insertImages = useCallback(async (files: File[]) => {
    const wrap = wrapRef.current;
    if (!wrap || files.length === 0) return;
    const currentQ = questionIdRef.current;
    const viewport = {
      left: 0,
      top: scrollMode === 'scroll-y' ? wrap.scrollTop : 0,
      width: wrap.clientWidth,
      height: wrap.clientHeight,
    };
    for (let i = 0; i < files.length; i++) {
      const img = await fileToDraftImage(files[i], wrap.clientWidth, viewport);
      if (questionIdRef.current !== currentQ) return; // 切题了，放弃在途插入
      if (i > 0) { img.x += i * 16; img.y += i * 16; }
      updateImages((prev) => [...prev, img]);
    }
  }, [scrollMode, updateImages]);

  // 剪贴板粘贴：组件随抽屉/面板条件挂载，监听生命周期 = 草稿可见期；
  // 焦点在输入框时放行（正常粘贴文本），只拦图片文件
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const file = Array.from(e.clipboardData?.items ?? [])
        .find((it) => it.kind === 'file' && it.type.startsWith('image/'))
        ?.getAsFile();
      if (!file) return;
      e.preventDefault();
      void insertImages([file]);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [insertImages]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const ink = (getComputedStyle(canvas).getPropertyValue('--text-primary') || '#333').trim();
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
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
    imagesRef.current = persist ? getDraftImages(questionId) : [];
    setImages(imagesRef.current);
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
    strokesRef.current.push({ points: [p], size: INK_WIDTH });
    redraw(); // 落笔即渲染：单点（点按）立即成点、连续笔画无"起笔延迟"
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
    imagesRef.current = [];
    setImages([]);
    if (persist) clearDraft(questionId); // store 层双清笔迹 + 贴图
    redraw();
  };

  // 画布元素：两种模式共用一份 JSX（refs/handlers/样式相同），差异只在套的外层容器
  const canvasEl = (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      // 移动档 canvas 穿透：贴图层接管交互；scroll-y 两指平移退化为浏览器原生滚动（有意为之）
      style={{ touchAction: 'none', pointerEvents: tool === 'move' ? 'none' : 'auto', cursor: tool === 'move' ? 'default' : tool === 'eraser' ? 'cell' : 'crosshair' }}
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
    <div
      className="h-full flex flex-col"
      onDragOver={(e) => { e.preventDefault(); }}
      onDrop={(e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
        void insertImages(files);
      }}
    >
      {/* 工具条 */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--bg-subtle)]">
        {toolBtn('pen', '手写笔', <PenIcon />)}
        {toolBtn('eraser', '橡皮', <EraserIcon />)}
        {toolBtn('move', '移动', <MoveIcon />)}
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
            <DraftImageLayer key={questionId} images={images} onImagesChange={updateImages} interactive={tool === 'move'} />
            {canvasEl}
          </div>
        </div>
      ) : (
        <div ref={wrapRef} className="flex-1 min-h-0 relative">
          <DraftImageLayer key={questionId} images={images} onImagesChange={updateImages} interactive={tool === 'move'} />
          {canvasEl}
        </div>
      )}
    </div>
  );
}
