import { useEffect, useRef, useState, useCallback } from 'react';
import { useThemeStore } from '@/store/themeStore';
import {
  getDraft, setDraft, clearDraft, getDraftImages, setDraftImages,
  type Stroke, type DraftImage, type DraftPoint,
} from './draft-store';
import {
  type CompassState, angleAt, handlePos, hitHandle, normalizeAngle, sampleArc, sampleCircle,
  MIN_R, DEFAULT_R, TAP_SLOP, MIN_SWEEP,
} from './draft-compass';
import { DraftImageLayer } from './DraftImageLayer';
import { fileToDraftImage, isEditableTarget } from './draft-image-utils';

type Tool = 'pen' | 'dot' | 'eraser' | 'select' | 'compass' | 'line' | 'rect' | 'ellipse' | 'triangle';

/** 拖拽成形的图形工具（直线/矩形/椭圆），共用同一手势骨架 */
type ShapeKind = 'line' | 'rect' | 'ellipse';
const SHAPE_TOOLS: ReadonlySet<Tool> = new Set<Tool>(['line', 'rect', 'ellipse']);

/** 笔迹线宽（CSS px）：恒定线宽细线（钢笔感），无 thinning 粗细起伏 */
const INK_WIDTH = 2;

/** 圆心标记点半径（CSS px）：与圆规参考层的圆心锚点同尺寸，保持「画的圆心」和「预览的圆心」观感一致 */
const CENTER_DOT_R = 3;

/** 「点」工具直径（CSS px）：落点是一根单点笔迹，渲染半径 = DOT_SIZE / 2（strokePath 对单点笔迹按 size/2 画实心圆） */
const DOT_SIZE = 10;

/**
 * 单条笔画平滑渲染（取代 perfect-freehand 填充轮廓画法）：
 * - 统一细线宽 + 圆头圆角（lineCap/lineJoin round），细且均匀；
 * - 用「顶点为控制点、相邻顶点中点为起止」的二次贝塞尔段串成连续曲线（C1 连续），
 *   曲线天然穿过相邻点中点 = 渲染期低通（抑制手抖高频抖动）；
 * - 输入侧不做 EWMA 前向平滑（之前 streamline 让笔尖滞后），最新采样点直接落笔 →
 *   渲染零跟手延迟。stroke.size 通常为 INK_WIDTH（「点」工具为 DOT_SIZE，单点笔迹取它当直径）。
 * - stroke.center 存在时（正圆）在轮廓之上补一个实心圆心点。
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
  if (stroke.center) {
    // 正圆圆心标记：实心点（颜色取调用方设的 fillStyle，与笔迹同色）
    ctx.beginPath();
    ctx.arc(stroke.center.x, stroke.center.y, CENTER_DOT_R, 0, Math.PI * 2);
    ctx.fill();
  }
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

/** 笔画包围盒（选中框/框选相交判定用；点数为 0 的笔画不会出现在笔迹数组中） */
function strokeBounds(s: Stroke): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of s.points) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  // 单点笔迹（点工具/手写笔点按）没有长度，按墨迹半径 size/2 外扩，否则「点」会被选中虚线框切掉
  if (s.points.length === 1) {
    const r = s.size / 2;
    x0 -= r; y0 -= r; x1 += r; y1 += r;
  }
  return { x0, y0, x1, y1 };
}

/** scroll-y 模式画板高 = 容器可视高 × 该系数（纵向滚动条由此产生） */
const SCROLL_Y_FACTOR = 1.6;

/** 选中集初始值（模块级常量，避免每次渲染新 Set 触发贴图层不必要更新） */
const EMPTY_SET: ReadonlySet<never> = new Set();

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

/** 选中工具（光标箭头） */
const SelectIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
  </svg>
);

/** 点工具（实心圆点 = 几何作图里的「点」标记） */
const DotIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" fill="currentColor" />
  </svg>
);

/** 直线工具（两端带端点的斜线） */
const LineIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="19" x2="19" y2="5" />
    <circle cx="5" cy="19" r="1.5" />
    <circle cx="19" cy="5" r="1.5" />
  </svg>
);

/** 矩形工具 */
const RectIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="6" width="16" height="12" rx="1" />
  </svg>
);

/** 椭圆工具 */
const EllipseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="12" rx="8" ry="6" />
  </svg>
);

/** 三角形工具（三顶点带锚点） */
const TriangleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5L21 19H3z" />
    <circle cx="12" cy="5" r="1.5" />
    <circle cx="21" cy="19" r="1.5" />
    <circle cx="3" cy="19" r="1.5" />
  </svg>
);

/** 三角形状态机：idle(未起笔) → placing(已放 1~2 顶点，橡皮筋跟手) → adjust(3 顶点齐，可拖拽调整) */
interface TriVert { x: number; y: number }
type TriangleState =
  | { phase: 'idle' }
  | { phase: 'placing'; verts: TriVert[]; cursor: { x: number; y: number } }
  | { phase: 'adjust'; verts: [TriVert, TriVert, TriVert] };

/** 底边 (ax,ay)-(bx,by) 的等边三角形第三顶点；side=+1/-1 为底边两侧 */
function equilateralPoint(ax: number, ay: number, bx: number, by: number, side: 1 | -1): { x: number; y: number } {
  const h = Math.sqrt(3) / 2;
  return {
    x: (ax + bx) / 2 - side * (by - ay) * h,
    y: (ay + by) / 2 + side * (bx - ax) * h,
  };
}

/** 靠近指针一侧的等边顶点（Shift 等边约束：顶点取对面边的等边点，落在指针所在一侧） */
function nearestEquilateral(a: TriVert, b: TriVert, px: number, py: number): { x: number; y: number } {
  const p1 = equilateralPoint(a.x, a.y, b.x, b.y, 1);
  const p2 = equilateralPoint(a.x, a.y, b.x, b.y, -1);
  return Math.hypot(p1.x - px, p1.y - py) <= Math.hypot(p2.x - px, p2.y - py) ? p1 : p2;
}

/** 直线 Shift 吸附：方向吸附到最近的 45° 倍数（0/45/90/135°），长度取投影（落点在手势方向上的正投影） */
function snapLineAngle(x0: number, y0: number, x1: number, y1: number): { x: number; y: number } {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: x1, y: y1 };
  const snapped = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: x0 + len * Math.cos(snapped), y: y0 + len * Math.sin(snapped) };
}

/** 矩形/椭圆 Shift 约束：包围盒修正为正方形（取 |dx|/|dy| 较大者，保持拖拽方向象限） */
function squareBox(x0: number, y0: number, x1: number, y1: number): { x: number; y: number } {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const s = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: x0 + Math.sign(dx || 1) * s, y: y0 + Math.sign(dy || 1) * s };
}

/** 闭合多边形采样：沿边按 ~3px 弦长加密 + 末点闭合（矩形/三角形共用）。
 *  不能只采顶点——strokePath 的「中点二次贝塞尔」平滑会让稀疏拐角点沦为控制点被曲线绕过，
 *  拐角各被削掉约 1/4 边长（正方形看起来成大圆角方块）；加密后拐角仅剩笔迹级微圆。 */
function sampleClosedPolygon(vertices: { x: number; y: number }[]): DraftPoint[] {
  const n = vertices.length;
  if (n === 0) return [];
  const points: DraftPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    const m = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 3));
    for (let j = 0; j < m; j++) {
      const t = j / m;
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: 0.5 });
    }
  }
  const first = vertices[0];
  points.push({ x: first.x, y: first.y, pressure: 0.5 }); // 末点闭合回起点
  return points;
}

/** 椭圆采样：轴对齐包围盒内参数化椭圆，弦长 ~1.5px 自适应 + 最少 64 点封底，末点闭合 */
function sampleEllipse(x0: number, y0: number, x1: number, y1: number): DraftPoint[] {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2;
  const ry = Math.abs(y1 - y0) / 2;
  if (rx < 0.5 && ry < 0.5) return [{ x: cx, y: cy, pressure: 0.5 }];
  const r = Math.max(rx, ry);
  const step = Math.max((2 * Math.PI) / 64, 2 * Math.asin(Math.min(0.75, r / 2) / Math.max(r, 1)));
  const n = Math.max(64, Math.ceil((2 * Math.PI) / step));
  const points: DraftPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    points.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), pressure: 0.5 });
  }
  return points;
}

/** 图形手势（直线/矩形/椭圆共用骨架）的预览与提交点列：Shift 约束在此统一生效。
 *  center 仅椭圆按住 Shift（包围盒被修正为正方形 = 正圆）时给出——未按 Shift 的椭圆、直线、矩形都不标圆心。 */
function shapeCommitPoints(
  kind: 'line' | 'rect' | 'ellipse',
  g: { x0: number; y0: number; x1: number; y1: number; shift: boolean },
): { points: DraftPoint[]; center?: DraftPoint } {
  if (kind === 'line') {
    const end = g.shift ? snapLineAngle(g.x0, g.y0, g.x1, g.y1) : { x: g.x1, y: g.y1 };
    return {
      points: [
        { x: g.x0, y: g.y0, pressure: 0.5 },
        { x: end.x, y: end.y, pressure: 0.5 },
      ],
    };
  }
  const corner = g.shift ? squareBox(g.x0, g.y0, g.x1, g.y1) : { x: g.x1, y: g.y1 };
  if (kind === 'rect') {
    return {
      points: sampleClosedPolygon([
        { x: g.x0, y: g.y0 }, { x: corner.x, y: g.y0 },
        { x: corner.x, y: corner.y }, { x: g.x0, y: corner.y },
      ]),
    };
  }
  const points = sampleEllipse(g.x0, g.y0, corner.x, corner.y);
  if (!g.shift) return { points };
  return {
    points,
    center: { x: (g.x0 + corner.x) / 2, y: (g.y0 + corner.y) / 2, pressure: 0.5 },
  };
}

/** 圆规（制图双脚圆规：顶部铰链 + 双腿 + 底部画出的弧） */
const CompassIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="4.5" r="1.5" />
    <path d="M12 6.5L8.5 18.5" />
    <path d="M12 6.5L15.5 18.5" />
    <path d="M5 15A8 8 0 0 0 19 15" />
  </svg>
);

/**
 * 圆规参考层（仅 compass 工具激活时叠加在笔迹之上）：
 * 虚线参考圆 + 圆心→手柄半径线 + 圆心/手柄锚点；placing/resizing 手柄旁显示半径数值；
 * drawing 时用笔迹同款 strokePath 画弧实时预览（视觉上即「正在画出」）。
 */
function drawCompassOverlay(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  c: CompassState,
  handleAngle: number,
  ink: string,
): void {
  if (c.phase === 'idle') return;
  const guide = (getComputedStyle(canvas).getPropertyValue('--text-tertiary') || '#999').trim();
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = guide;
  ctx.fillStyle = ink;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.arc(c.cx, c.cy, Math.max(c.r, 0.5), 0, Math.PI * 2);
  ctx.stroke();
  const h = handlePos(c, handleAngle);
  ctx.beginPath();
  ctx.moveTo(c.cx, c.cy);
  ctx.lineTo(h.x, h.y);
  ctx.stroke();
  ctx.setLineDash([]);
  // 圆心与半径手柄锚点（ink 色实心点）；圆心点尺寸与提交后笔迹上的圆心标记一致
  ctx.beginPath();
  ctx.arc(c.cx, c.cy, CENTER_DOT_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(h.x, h.y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  if (c.phase === 'drawing' && Math.abs(c.sweep) > 1e-9) {
    strokePath(ctx, { points: sampleArc(c, c.a0, c.sweep), size: INK_WIDTH });
  }
  if (c.phase === 'placing' || c.phase === 'resizing') {
    ctx.fillStyle = guide;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${Math.round(c.r)}`, h.x + 8, h.y - 8);
  }
  ctx.restore();
}

/**
 * 选中层（仅 select 工具激活时叠加）：选中元素（笔画/贴图）的虚线包围盒 + 框选拖拽矩形。
 * 笔画平移按点列原位改写（无副本），包围盒每次重绘现算——单笔画点列最多千级，开销可忽略。
 */
function drawSelectionOverlay(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  selectedStrokes: ReadonlySet<Stroke>,
  images: DraftImage[],
  selectedImageIds: ReadonlySet<string>,
  marquee: { startX: number; startY: number; x: number; y: number } | null,
): void {
  const brand = (getComputedStyle(canvas).getPropertyValue('--brand-500') || '#ff6b35').trim();
  ctx.save();
  ctx.strokeStyle = brand;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (const s of selectedStrokes) {
    const b = strokeBounds(s);
    ctx.strokeRect(b.x0 - 4, b.y0 - 4, Math.max(b.x1 - b.x0, 1) + 8, Math.max(b.y1 - b.y0, 1) + 8);
  }
  for (const im of images) {
    if (!selectedImageIds.has(im.id)) continue;
    ctx.strokeRect(im.x - 2, im.y - 2, im.w + 4, im.h + 4);
  }
  if (marquee) {
    const x0 = Math.min(marquee.startX, marquee.x);
    const y0 = Math.min(marquee.startY, marquee.y);
    const w = Math.abs(marquee.x - marquee.startX);
    const h = Math.abs(marquee.y - marquee.startY);
    ctx.fillStyle = brand;
    ctx.globalAlpha = 0.06;
    ctx.fillRect(x0, y0, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeRect(x0, y0, w, h);
  }
  ctx.restore();
}

/**
 * 三角形参考层（仅 triangle 工具激活时叠加）：
 * placing：已定边实线 + 末顶点→光标虚线橡皮筋 + 顶点锚点；
 * adjust：三边实线预览（与提交同款 sampleClosedPolygon，WYSIWYG）+ 顶点锚点（可拖拽提示）。
 */
function drawTriangleOverlay(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  t: TriangleState,
  ink: string,
): void {
  if (t.phase === 'idle') return;
  const guide = (getComputedStyle(canvas).getPropertyValue('--text-tertiary') || '#999').trim();
  ctx.save();
  ctx.fillStyle = ink;
  if (t.phase === 'placing') {
    if (t.verts.length >= 2) {
      // 已定边：实线（与最终观感一致）
      strokePath(ctx, {
        points: t.verts.map((v) => ({ ...v, pressure: 0.5 })),
        size: INK_WIDTH,
      });
    }
    const last = t.verts[t.verts.length - 1];
    if (t.cursor) {
      // 橡皮筋：末顶点 → 光标（虚线参考）
      ctx.strokeStyle = guide;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(t.cursor.x, t.cursor.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  } else {
    // adjust：整三角形实线预览（提交同款采样）
    strokePath(ctx, { points: sampleClosedPolygon(t.verts), size: INK_WIDTH });
  }
  for (const v of t.verts) {
    ctx.beginPath();
    ctx.arc(v.x, v.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

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
  const toolRef = useRef<Tool>('pen'); // redraw（dep-free）读工具态判断是否画圆规参考层
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  // 两指平移（仅 scroll-y 模式）：活动指针表（pointerId -> 该指针 clientY）+ 平移标志 + 上一帧质心 clientY
  const activePointersRef = useRef<Map<number, { y: number }>>(new Map());
  const panRef = useRef(false);
  const panLastYRef = useRef(0);
  // 圆规状态机：state 供控制条渲染（提示文案/半径读数），ref 供指针手势与 redraw 读写（连续更新不拿旧闭包）
  const [compass, setCompass] = useState<CompassState>({ phase: 'idle' });
  const compassRef = useRef<CompassState>({ phase: 'idle' });
  // 半径记忆（点按放置沿用上次半径 = 拿起预先张好的圆规）、手柄锚角、画弧手势起点（点按/拖动判定）
  const compassLastRRef = useRef(DEFAULT_R);
  const compassHandleAngleRef = useRef(0);
  const compassDownRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // 图形手势（直线/矩形/椭圆共用骨架）：按下定锚点、拖出终点/对角；Shift 约束（直线吸附 45° 倍数，
  // 矩形/椭圆转正方形/正圆）；moved 过点按阈值才成形；kind 记录起手工具（手势中切工具不串形）
  const shapeGestureRef = useRef<{
    kind: ShapeKind; x0: number; y0: number; x1: number; y1: number; moved: boolean; shift: boolean;
  } | null>(null);
  // 三角形状态机：state 供控制条渲染（提示文案/确认按钮），ref 供手势与 redraw 读写；
  // triDragRef = 正在拖拽微调的顶点下标（放置时按下即放、拖动微调；adjust 态拖顶点手柄调整）
  const [triangle, setTriangle] = useState<TriangleState>({ phase: 'idle' });
  const triangleRef = useRef<TriangleState>({ phase: 'idle' });
  const triDragRef = useRef<number | null>(null);
  // 选中工具：选区（笔画按对象引用、图片按 id）。图片选集另有 state 镜像（驱动贴图层选中态/控制点）；
  // 笔画选中框画在 canvas 上（redraw 读 ref），无需 state。手势态：拖动移动 / 空白框选，
  // 拖动带图片原位快照（按手势起点绝对定位，防逐帧增量取整漂移）
  const [selectedImageIds, setSelectedImageIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const selectedStrokesRef = useRef<Set<Stroke>>(new Set());
  const selectedImageIdsRef = useRef<Set<string>>(new Set());
  const selectGestureRef = useRef<
    | { kind: 'move'; startX: number; startY: number; lastX: number; lastY: number; origImages: Map<string, { x: number; y: number }> }
    | { kind: 'marquee'; startX: number; startY: number; x: number; y: number }
    | null
  >(null);
  const themeMode = useThemeStore((s) => s.mode);

  // 切题竞态防护：在途图片解码（FileReader/Image，几百 ms）期间切题，放弃插入避免污染新题视图/覆写旧题 store
  const questionIdRef = useRef(questionId);
  useEffect(() => { questionIdRef.current = questionId; }, [questionId]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const ink = (getComputedStyle(canvas).getPropertyValue('--text-primary') || '#333').trim();
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    for (const s of strokesRef.current) strokePath(ctx, s);
    if (toolRef.current === 'compass') {
      drawCompassOverlay(ctx, canvas, compassRef.current, compassHandleAngleRef.current, ink);
    }
    if (toolRef.current === 'select') {
      const g = selectGestureRef.current;
      drawSelectionOverlay(
        ctx, canvas, selectedStrokesRef.current, imagesRef.current, selectedImageIdsRef.current,
        g && g.kind === 'marquee' ? g : null,
      );
    }
    if (SHAPE_TOOLS.has(toolRef.current)) {
      // 图形实时预览：与最终提交同款实线（WYSIWYG），Shift 约束与圆心标记同步生效
      const g = shapeGestureRef.current;
      if (g && g.moved) {
        const out = shapeCommitPoints(g.kind, g);
        strokePath(ctx, { points: out.points, size: INK_WIDTH, center: out.center });
      }
    }
    if (toolRef.current === 'triangle') {
      drawTriangleOverlay(ctx, canvas, triangleRef.current, ink);
    }
  }, []);

  // 贴图：React state 渲染 + ref 镜像（异步插入/连续更新不拿旧闭包）；persist 时同步落 draft-store；
  // 图片被删除（删除钮/Delete 键）后同步从选区清掉 + 重绘（否则 canvas 上残留已删图片的选中框）
  const [images, setImages] = useState<DraftImage[]>([]);
  const imagesRef = useRef<DraftImage[]>([]);
  const updateImages = useCallback((updater: (prev: DraftImage[]) => DraftImage[]) => {
    const next = updater(imagesRef.current);
    imagesRef.current = next;
    setImages(next);
    if (persist) setDraftImages(questionId, next);
    const sel = selectedImageIdsRef.current;
    if (sel.size) {
      const alive = new Set(next.filter((im) => sel.has(im.id)).map((im) => im.id));
      if (alive.size !== sel.size) {
        selectedImageIdsRef.current = alive;
        setSelectedImageIds(alive);
        redraw();
      }
    }
  }, [persist, questionId, redraw]);

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

  // 圆规状态更新：ref + state 同步 + 重绘（参考层读 ref）
  const updateCompass = useCallback((next: CompassState) => {
    compassRef.current = next;
    setCompass(next);
    redraw();
  }, [redraw]);

  // 图形工具产出（弧/整圆/直线，后续矩形/椭圆/三角形同）提交：与手写笔迹同管道（渲染/橡皮/持久化）
  // center 仅正圆传入（圆规整圆 / Shift 正圆），其余图形不传
  const commitShapeStroke = useCallback((points: DraftPoint[], center?: DraftPoint) => {
    strokesRef.current.push(center ? { points, size: INK_WIDTH, center } : { points, size: INK_WIDTH });
    if (persist) setDraft(questionId, strokesRef.current);
    redraw();
  }, [persist, questionId, redraw]);

  // —— 圆规单指针状态机（board 坐标；交互规范见设计文档 §3.1）——
  const compassDown = (x: number, y: number) => {
    const c = compassRef.current;
    if (c.phase === 'placing' || c.phase === 'resizing' || c.phase === 'drawing') return; // 手势中忽略新指针
    if (c.phase === 'idle') {
      compassDownRef.current = { x, y, moved: false };
      updateCompass({ phase: 'placing', cx: x, cy: y, r: 0 });
      return;
    }
    if (hitHandle(c, compassHandleAngleRef.current, x, y)) {
      updateCompass({ ...c, phase: 'resizing' });
    } else {
      compassDownRef.current = { x, y, moved: false };
      updateCompass({ ...c, phase: 'drawing', a0: angleAt(c.cx, c.cy, x, y), sweep: 0 });
    }
  };

  const compassMove = (x: number, y: number) => {
    const c = compassRef.current;
    if (c.phase === 'placing' || c.phase === 'resizing') {
      // 拖动调半径：手柄锚角跟手；resizing 即时 clamp，placing 落定时再判定
      compassHandleAngleRef.current = angleAt(c.cx, c.cy, x, y);
      const dist = Math.hypot(x - c.cx, y - c.cy);
      const r = c.phase === 'resizing' ? Math.max(MIN_R, dist) : dist;
      updateCompass({ ...c, r });
      return;
    }
    if (c.phase !== 'drawing') return;
    const d = compassDownRef.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.hypot(x - d.x, y - d.y) <= TAP_SLOP) return; // 还在点按容差内，未开始画
      // 越过点按阈值，画弧真正开始：起点角取此刻指针方位，手柄随起点
      d.moved = true;
      const a0 = angleAt(c.cx, c.cy, x, y);
      compassHandleAngleRef.current = a0;
      updateCompass({ ...c, a0, sweep: 0 });
      return;
    }
    // 扫过角按最短角差方向累积（可来回改向）；当前累计角 = a0 + sweep
    const ang = angleAt(c.cx, c.cy, x, y);
    const sweep = c.sweep + normalizeAngle(ang - (c.a0 + c.sweep));
    if (Math.abs(sweep) >= 2 * Math.PI) {
      // 扫满一周：自动闭合成整圆并提交（整圆带圆心标记）
      commitShapeStroke(sampleCircle(c), { x: c.cx, y: c.cy, pressure: 0.5 });
      updateCompass({ ...c, phase: 'ready' });
      return;
    }
    updateCompass({ ...c, sweep });
  };

  const compassUp = (x: number, y: number) => {
    const c = compassRef.current;
    if (c.phase === 'placing') {
      // 拖出有效半径则记忆；未拖出（点按）沿用上次记忆半径
      const r = c.r >= MIN_R ? c.r : compassLastRRef.current;
      compassLastRRef.current = r;
      compassHandleAngleRef.current = angleAt(c.cx, c.cy, x, y);
      updateCompass({ phase: 'ready', cx: c.cx, cy: c.cy, r });
      return;
    }
    if (c.phase === 'resizing') {
      compassLastRRef.current = c.r;
      compassHandleAngleRef.current = angleAt(c.cx, c.cy, x, y);
      updateCompass({ ...c, phase: 'ready' });
      return;
    }
    if (c.phase === 'drawing') {
      const d = compassDownRef.current;
      if (d && !d.moved) {
        // 点按：搬移圆心、半径保持（拿起圆规换位置，等半径多弧作图）
        updateCompass({ phase: 'ready', cx: d.x, cy: d.y, r: c.r });
        return;
      }
      if (Math.abs(c.sweep) >= MIN_SWEEP) commitShapeStroke(sampleArc(c, c.a0, c.sweep));
      updateCompass({ ...c, phase: 'ready' });
    }
  };

  // 系统打断（pointercancel / 丢失捕获 / 两指平移接管）：手势取消——进行中的弧不提交，回 ready
  const cancelCompass = () => {
    const c = compassRef.current;
    if (c.phase === 'placing') {
      const r = c.r >= MIN_R ? c.r : compassLastRRef.current;
      compassLastRRef.current = r;
      updateCompass({ phase: 'ready', cx: c.cx, cy: c.cy, r });
    } else if (c.phase === 'resizing' || c.phase === 'drawing') {
      updateCompass({ ...c, phase: 'ready' });
    }
  };

  // —— 图形工具（直线/矩形/椭圆）：按下定锚点，拖动实时预览（WYSIWYG 实线），抬手采样提交 Stroke ——
  // （直线 = 两点笔画，矩形 = 四角折线闭合，椭圆 = 参数化采样；橡皮/选中/主题管道全复用）

  const shapeDown = (kind: ShapeKind, x: number, y: number) => {
    shapeGestureRef.current = { kind, x0: x, y0: y, x1: x, y1: y, moved: false, shift: false };
  };

  const shapeMove = (x: number, y: number, shiftKey: boolean) => {
    const g = shapeGestureRef.current;
    if (!g) return;
    if (!g.moved) {
      if (Math.hypot(x - g.x0, y - g.y0) <= TAP_SLOP) return; // 还在点按容差内，未成形
      g.moved = true;
    }
    g.x1 = x; g.y1 = y; g.shift = shiftKey;
    redraw();
  };

  const shapeUp = () => {
    const g = shapeGestureRef.current;
    shapeGestureRef.current = null;
    if (g && g.moved) {
      const out = shapeCommitPoints(g.kind, g);
      commitShapeStroke(out.points, out.center);
    } else {
      redraw(); // 未成形（点按）：清掉可能的空预览
    }
  };

  const cancelShape = () => {
    if (!shapeGestureRef.current) return;
    shapeGestureRef.current = null;
    redraw();
  };

  // —— 三角形工具：点放置顶点（按下即放、拖动微调），三点齐后拖顶点调整，确认提交 ——

  const updateTriangle = useCallback((next: TriangleState) => {
    triangleRef.current = next;
    setTriangle(next);
    redraw();
  }, [redraw]);

  /** 顶点手柄命中半径（px） */
  const TRI_HANDLE_HIT = 14;

  /** 拖拽调整某顶点（placing/adjust 态共用）；adjust 态 Shift = 取对面边等边点（靠指针一侧） */
  const moveTriangleVertex = (index: number, x: number, y: number, shiftKey: boolean) => {
    const t = triangleRef.current;
    if (t.phase === 'idle') return;
    const verts = t.verts.map((v) => ({ ...v }));
    if (shiftKey && t.phase === 'adjust') {
      const others = verts.filter((_, i) => i !== index);
      verts[index] = nearestEquilateral(others[0], others[1], x, y);
    } else {
      verts[index] = { x, y };
    }
    updateTriangle(t.phase === 'placing'
      ? { phase: 'placing', verts, cursor: { x, y } }
      : { phase: 'adjust', verts: [verts[0], verts[1], verts[2]] });
  };

  const triangleDown = (x: number, y: number, shiftKey: boolean) => {
    const t = triangleRef.current;
    if (t.phase === 'adjust') {
      // 拖顶点手柄调整（空白处按下忽略：调整期只动顶点，确认走控制条/Enter）
      for (let i = 0; i < 3; i++) {
        if (Math.hypot(t.verts[i].x - x, t.verts[i].y - y) <= TRI_HANDLE_HIT) {
          triDragRef.current = i;
          const canvas = canvasRef.current;
          if (canvas) canvas.style.cursor = 'grabbing';
          moveTriangleVertex(i, x, y, shiftKey);
          return;
        }
      }
      return;
    }
    // placing / idle（视作 0 顶点的 placing）：放下一个顶点，按下即放、拖动继续微调该顶点，抬手固定
    const verts = [...(t.phase === 'placing' ? t.verts : []), { x, y }];
    triDragRef.current = verts.length - 1;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'grabbing';
    if (verts.length < 3) {
      updateTriangle({ phase: 'placing', verts, cursor: { x, y } });
    } else {
      // 第三顶点：Shift = 底边等边点（靠指针一侧），后续拖拽中按住 Shift 持续吸附
      if (shiftKey) verts[2] = nearestEquilateral(verts[0], verts[1], x, y);
      updateTriangle({ phase: 'adjust', verts: [verts[0], verts[1], verts[2]] });
    }
  };

  const triangleMove = (x: number, y: number, shiftKey: boolean) => {
    const t = triangleRef.current;
    if (t.phase === 'idle') return;
    const d = triDragRef.current;
    if (d !== null) {
      moveTriangleVertex(d, x, y, shiftKey);
      return;
    }
    if (t.phase === 'placing') updateTriangle({ ...t, cursor: { x, y } }); // 橡皮筋跟手
  };

  const triangleUp = () => {
    triDragRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'crosshair';
  };

  /** 确认提交：三点采样为闭合笔画（与矩形同款加密防削角），回 idle */
  const confirmTriangle = useCallback(() => {
    const t = triangleRef.current;
    if (t.phase !== 'adjust') return;
    commitShapeStroke(sampleClosedPolygon(t.verts));
    triDragRef.current = null;
    updateTriangle({ phase: 'idle' });
  }, [commitShapeStroke, updateTriangle]);

  const resetTriangle = useCallback(() => {
    triDragRef.current = null;
    updateTriangle({ phase: 'idle' });
  }, [updateTriangle]);

  // —— 选中工具：点选 / Shift 加选 / 框选 / 拖动移动（笔画与贴图统一，board 坐标）——

  const setSelection = useCallback((strokes: Set<Stroke>, imageIds: Set<string>) => {
    selectedStrokesRef.current = strokes;
    selectedImageIdsRef.current = imageIds;
    setSelectedImageIds(imageIds);
    redraw();
  }, [redraw]);

  /** 命中检测：笔画优先（canvas 恒绘制在贴图之上，视觉上层先命中），均从末位（最上层）向前找 */
  const hitElement = (x: number, y: number): { stroke: Stroke } | { imageId: string } | null => {
    for (let i = strokesRef.current.length - 1; i >= 0; i--) {
      const s = strokesRef.current[i];
      if (hitStroke(s, x, y)) return { stroke: s };
    }
    for (let i = imagesRef.current.length - 1; i >= 0; i--) {
      const im = imagesRef.current[i];
      if (x >= im.x && x <= im.x + im.w && y >= im.y && y <= im.y + im.h) return { imageId: im.id };
    }
    return null;
  };

  /** 点是否落在任一选中元素的包围盒内（外扩 4px 容差）——选中元素的「包围盒整体」是抓取区：
   *  圆/矩形等空心图形的内部空腔也能拖动，悬停光标变抓手。 */
  const insideSelectionBounds = (x: number, y: number): boolean => {
    for (const s of selectedStrokesRef.current) {
      const b = strokeBounds(s);
      if (x >= b.x0 - 4 && x <= b.x1 + 4 && y >= b.y0 - 4 && y <= b.y1 + 4) return true;
    }
    for (const im of imagesRef.current) {
      if (!selectedImageIdsRef.current.has(im.id)) continue;
      if (x >= im.x - 4 && x <= im.x + im.w + 4 && y >= im.y - 4 && y <= im.y + im.h + 4) return true;
    }
    return false;
  };

  const selectDown = (x: number, y: number, shiftKey: boolean) => {
    const hit = hitElement(x, y);
    if (hit && 'stroke' in hit) {
      if (shiftKey) { // 加选/移出选区，不起移动手势
        const next = new Set(selectedStrokesRef.current);
        if (next.has(hit.stroke)) next.delete(hit.stroke); else next.add(hit.stroke);
        setSelection(next, selectedImageIdsRef.current);
        return;
      }
      if (!selectedStrokesRef.current.has(hit.stroke)) setSelection(new Set([hit.stroke]), new Set());
    } else if (hit) {
      if (shiftKey) {
        const next = new Set(selectedImageIdsRef.current);
        if (next.has(hit.imageId)) next.delete(hit.imageId); else next.add(hit.imageId);
        setSelection(selectedStrokesRef.current, next);
        return;
      }
      if (!selectedImageIdsRef.current.has(hit.imageId)) setSelection(new Set(), new Set([hit.imageId]));
    } else if (!insideSelectionBounds(x, y)) {
      // 空白且不在任何选中元素的包围盒内：框选待定（抬手位移不超阈值视为点按 → 清空选区）
      selectGestureRef.current = { kind: 'marquee', startX: x, startY: y, x, y };
      return;
    }
    // 点中元素或落在选中包围盒内（选中态已就绪）：起移动手势；
    // 图片原位快照——按手势起点绝对定位，避免逐帧增量取整漂移
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'grabbing';
    const origImages = new Map(
      imagesRef.current
        .filter((im) => selectedImageIdsRef.current.has(im.id))
        .map((im) => [im.id, { x: im.x, y: im.y }] as const),
    );
    selectGestureRef.current = { kind: 'move', startX: x, startY: y, lastX: x, lastY: y, origImages };
  };

  const selectMove = (x: number, y: number) => {
    const g = selectGestureRef.current;
    const canvas = canvasRef.current;
    if (!g) {
      // 悬停：落在选中包围盒内显示抓手（抓取区提示；直接改 DOM 不走 React，避免逐帧重渲染）
      if (canvas) canvas.style.cursor = insideSelectionBounds(x, y) ? 'grab' : 'default';
      return;
    }
    if (g.kind === 'marquee') {
      g.x = x; g.y = y;
      redraw();
      return;
    }
    if (canvas) canvas.style.cursor = 'grabbing';
    const dx = x - g.lastX;
    const dy = y - g.lastY;
    if (dx === 0 && dy === 0) return;
    g.lastX = x; g.lastY = y;
    // 笔画：点列原位平移（浮点增量，无取整误差；圆心标记随之一并平移）；
    // 贴图：快照 + 总位移绝对定位（负方向夹 0）
    for (const s of selectedStrokesRef.current) {
      for (const p of s.points) { p.x += dx; p.y += dy; }
      if (s.center) { s.center.x += dx; s.center.y += dy; }
    }
    if (g.origImages.size) {
      const dxTotal = x - g.startX;
      const dyTotal = y - g.startY;
      const orig = g.origImages;
      updateImages((prev) => prev.map((im) => {
        const o = orig.get(im.id);
        return o
          ? { ...im, x: Math.max(0, Math.round(o.x + dxTotal)), y: Math.max(0, Math.round(o.y + dyTotal)) }
          : im;
      }));
    }
    redraw();
  };

  const selectUp = (x: number, y: number) => {
    const g = selectGestureRef.current;
    if (!g) return;
    selectGestureRef.current = null;
    if (g.kind === 'move') {
      if (persist) setDraft(questionId, strokesRef.current); // 笔画平移落盘（贴图已随 updateImages 逐帧落盘）
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = insideSelectionBounds(x, y) ? 'grab' : 'default';
      redraw();
      return;
    }
    if (Math.hypot(x - g.startX, y - g.startY) <= TAP_SLOP) {
      setSelection(new Set(), new Set()); // 点按空白：清空选区
      return;
    }
    // 框选落定：包围盒与框选矩形相交即选中（笔画 + 贴图并集）
    const x0 = Math.min(g.startX, x), x1 = Math.max(g.startX, x);
    const y0 = Math.min(g.startY, y), y1 = Math.max(g.startY, y);
    const strokes = new Set<Stroke>();
    for (const s of strokesRef.current) {
      const b = strokeBounds(s);
      if (b.x0 <= x1 && b.x1 >= x0 && b.y0 <= y1 && b.y1 >= y0) strokes.add(s);
    }
    const imageIds = new Set<string>();
    for (const im of imagesRef.current) {
      if (im.x <= x1 && im.x + im.w >= x0 && im.y <= y1 && im.y + im.h >= y0) imageIds.add(im.id);
    }
    setSelection(strokes, imageIds);
  };

  // 选中手势收尾（系统打断/丢失捕获/两指平移接管）：移动按当前位置落盘，框选丢弃
  const cancelSelect = () => {
    const g = selectGestureRef.current;
    if (!g) return;
    selectGestureRef.current = null;
    if (g.kind === 'move' && persist) setDraft(questionId, strokesRef.current);
    redraw();
  };

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

  // 切题：persist 时加载该题草稿；persist=false 时清空本地笔迹（草稿不保存，切题即空）；圆规/选区重置
  useEffect(() => {
    strokesRef.current = persist ? getDraft(questionId) : [];
    imagesRef.current = persist ? getDraftImages(questionId) : [];
    setImages(imagesRef.current);
    compassRef.current = { phase: 'idle' };
    setCompass({ phase: 'idle' });
    shapeGestureRef.current = null;
    triangleRef.current = { phase: 'idle' };
    setTriangle({ phase: 'idle' });
    triDragRef.current = null;
    selectedStrokesRef.current = new Set();
    selectedImageIdsRef.current = new Set();
    setSelectedImageIds(new Set());
    selectGestureRef.current = null;
    redraw();
  }, [questionId, persist, redraw]);

  // 工具切换：同步 redraw 用的 toolRef 并重绘（圆规参考层随工具显隐；圆规状态本身保留——
  // 学生擦掉画歪的弧后切回继续画，符合「放下圆规再拿起」的心智）
  useEffect(() => {
    toolRef.current = tool;
    redraw();
  }, [tool, redraw]);

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
      // 被擦掉的笔画若在选区内，同步移出（防选中框残留）
      const sel = selectedStrokesRef.current;
      if (sel.size) {
        const alive = new Set(strokesRef.current.filter((s) => sel.has(s)));
        if (alive.size !== sel.size) {
          selectedStrokesRef.current = alive;
        }
      }
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
    // scroll-y：每根落到画布的新指针都先记录（含第二根）；两指齐下进入平移，打断进行中的单指笔迹/圆规画弧
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
        if (compassRef.current.phase !== 'idle' && compassRef.current.phase !== 'ready') {
          cancelCompass(); // 平移打断画弧/调半径/放置：预览取消不提交，圆规保持 ready
        }
        if (selectGestureRef.current) {
          cancelSelect(); // 平移打断移动/框选：移动按当前位置落盘，框选丢弃
        }
        if (shapeGestureRef.current) {
          cancelShape(); // 平移打断画图形：预览取消不提交
        }
        if (triDragRef.current !== null) {
          triangleUp(); // 平移打断顶点拖拽：固定当前位置，状态保留
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
    if (tool === 'compass') {
      compassDown(p.x, p.y);
      return;
    }
    if (tool === 'select') {
      selectDown(p.x, p.y, e.shiftKey);
      return;
    }
    if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
      shapeDown(tool, p.x, p.y);
      return;
    }
    if (tool === 'triangle') {
      triangleDown(p.x, p.y, e.shiftKey);
      return;
    }
    if (tool === 'dot') {
      // 点：按下即落一个点（单点笔迹，size = 直径，渲染半径 size/2）。
      // 复用 drawingRef → 两指平移会撤销这个还没抬手落定的点（与手写笔点按同策略）。
      drawingRef.current = true;
      strokesRef.current.push({ points: [p], size: DOT_SIZE });
      if (persist) setDraft(questionId, strokesRef.current);
      redraw();
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
    if (tool === 'compass') {
      compassMove(p.x, p.y); // 非手势态（idle/ready）内部自动 no-op，悬停不触发重绘
      return;
    }
    if (tool === 'select') {
      selectMove(p.x, p.y); // 非手势态内部 no-op
      return;
    }
    if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
      shapeMove(p.x, p.y, e.shiftKey);
      return;
    }
    if (tool === 'triangle') {
      triangleMove(p.x, p.y, e.shiftKey);
      return;
    }
    if (tool === 'dot') return; // 点工具：落点已定，拖动不追加新点、也不连成线
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
    if (tool === 'compass') {
      const p = pointFromEvent(e);
      compassUp(p.x, p.y);
      return;
    }
    if (tool === 'select') {
      const p = pointFromEvent(e);
      selectUp(p.x, p.y);
      return;
    }
    if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
      shapeUp();
      return;
    }
    if (tool === 'triangle') {
      triangleUp();
      return;
    }
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (persist) setDraft(questionId, strokesRef.current);
  };

  // 系统打断（来电/手势接管）或捕获丢失：指针从表中移除；中断单指笔迹不落盘、圆规/选中手势收尾
  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    endPointer(e);
    drawingRef.current = false;
    cancelCompass();
    cancelSelect();
    cancelShape();
    if (triDragRef.current !== null) triangleUp(); // 顶点拖拽固定当前位置（不丢已放的三角形）
  };
  const handleLostPointerCapture = (e: React.PointerEvent<HTMLCanvasElement>) => {
    endPointer(e);
    cancelCompass(); // 正常抬手后此事件仍会触发，各 cancel 对无手势态幂等
    cancelSelect();
    cancelShape();
    if (triDragRef.current !== null) triangleUp();
  };

  const handleClear = () => {
    strokesRef.current = [];
    imagesRef.current = [];
    setImages([]);
    if (persist) clearDraft(questionId); // store 层双清笔迹 + 贴图
    updateCompass({ phase: 'idle' }); // 圆规一并重置（含重绘）
    shapeGestureRef.current = null;
    resetTriangle();
    selectGestureRef.current = null;
    setSelection(new Set(), new Set());
  };

  // 选中工具：Delete/Backspace 删除选中元素（笔画整条 / 贴图整张；焦点在输入框时放行）
  useEffect(() => {
    if (tool !== 'select') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (isEditableTarget(e.target)) return;
      const selS = selectedStrokesRef.current;
      const selI = selectedImageIdsRef.current;
      if (selS.size === 0 && selI.size === 0) return;
      e.preventDefault();
      if (selS.size) {
        strokesRef.current = strokesRef.current.filter((s) => !selS.has(s));
        if (persist) setDraft(questionId, strokesRef.current);
      }
      if (selI.size) updateImages((prev) => prev.filter((im) => !selI.has(im.id)));
      setSelection(new Set(), new Set());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tool, persist, questionId, updateImages, setSelection]);

  // 三角形工具：Enter 确认提交 / Escape 重置（焦点在输入框或按钮等可交互元素上时放行，不抢按键）
  useEffect(() => {
    if (tool !== 'triangle') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, button, a, [contenteditable]')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmTriangle();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        resetTriangle();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tool, confirmTriangle, resetTriangle]);

  // 圆规控制条操作：整圆（以当前圆心半径一键画整圆，带圆心标记）/ 重置（回未放置）
  const drawFullCircle = () => {
    const c = compassRef.current;
    if (c.phase !== 'ready') return;
    commitShapeStroke(sampleCircle(c), { x: c.cx, y: c.cy, pressure: 0.5 });
  };
  const resetCompass = () => updateCompass({ phase: 'idle' });

  // 画布元素：两种模式共用一份 JSX（refs/handlers/样式相同），差异只在套的外层容器
  const canvasEl = (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      // 所有工具 canvas 都接管指针（贴图本体穿透，选中/拖动/缩放控制点由各自层接事件）；
      // scroll-y 两指平移走 canvas 指针逻辑（touch-action:none 拦截原生手势）
      style={{ touchAction: 'none', pointerEvents: 'auto', cursor: tool === 'select' ? 'default' : tool === 'eraser' ? 'cell' : 'crosshair' }}
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
      {/* 工具条（flex-wrap：40% 窄抽屉下按钮多时折行，不溢出） */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--bg-subtle)]">
        {toolBtn('pen', '手写笔', <PenIcon />)}
        {toolBtn('compass', '圆规', <CompassIcon />)}
        {toolBtn('dot', '点（点按放置一个点）', <DotIcon />)}
        {toolBtn('line', '直线（按住 Shift 吸附 45° 方向）', <LineIcon />)}
        {toolBtn('rect', '矩形（按住 Shift 画正方形）', <RectIcon />)}
        {toolBtn('ellipse', '椭圆（按住 Shift 画正圆）', <EllipseIcon />)}
        {toolBtn('triangle', '三角形（三点成形，顶点可拖拽调整；Shift 等边）', <TriangleIcon />)}
        {toolBtn('eraser', '橡皮', <EraserIcon />)}
        {toolBtn('select', '选中（点选/框选，拖动移动，Delete 删除）', <SelectIcon />)}
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
      {/* 圆规控制条（工具条下条件渲染的第二行）：状态提示 + 半径读数 + 整圆/重置 */}
      {tool === 'compass' && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-[var(--bg-subtle)] text-xs text-[var(--text-tertiary)]">
          <span className="flex-1 min-w-0 truncate">
            {compass.phase === 'idle' ? '点按放置圆规，按住拖动调整半径' : '拖动画弧，点按移动圆心，拖动手柄调半径'}
          </span>
          {compass.phase !== 'idle' && (
            <>
              <span className="shrink-0 tabular-nums">半径 {Math.round(compass.r)}</span>
              <button
                type="button"
                onClick={drawFullCircle}
                title="以当前圆心和半径画整圆"
                className="shrink-0 h-[28px] px-2.5 rounded-lg border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] hover:bg-[var(--bg-subtle)] transition-colors"
              >
                整圆
              </button>
              <button
                type="button"
                onClick={resetCompass}
                title="重新放置圆规"
                className="shrink-0 h-[28px] px-2.5 rounded-lg border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] hover:bg-[var(--bg-subtle)] transition-colors"
              >
                重置
              </button>
            </>
          )}
        </div>
      )}
      {/* 三角形控制条：状态提示 + 确认/重置（三点齐后才可确认） */}
      {tool === 'triangle' && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-[var(--bg-subtle)] text-xs text-[var(--text-tertiary)]">
          <span className="flex-1 min-w-0 truncate">
            {triangle.phase === 'idle' && '依次点按放置三个顶点（按住拖动可微调落点）'}
            {triangle.phase === 'placing' && `已放 ${triangle.verts.length}/3 个顶点，继续点按（第三点按住 Shift = 等边）`}
            {triangle.phase === 'adjust' && '拖动顶点调整形状（Shift = 等边），Enter 或「确认」提交'}
          </span>
          {triangle.phase === 'adjust' && (
            <button
              type="button"
              onClick={confirmTriangle}
              title="提交当前三角形"
              className="shrink-0 h-[28px] px-2.5 rounded-lg border border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-500)] hover:opacity-80 transition-colors"
            >
              确认
            </button>
          )}
          {triangle.phase !== 'idle' && (
            <button
              type="button"
              onClick={resetTriangle}
              title="重新放置顶点"
              className="shrink-0 h-[28px] px-2.5 rounded-lg border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] hover:bg-[var(--bg-subtle)] transition-colors"
            >
              重置
            </button>
          )}
        </div>
      )}
      {/* 手写画布：fit 直接贴容器；scroll-y 包定高画板 div，外层 overflow-y-auto（仅纵向可滚） */}
      {scrollMode === 'scroll-y' ? (
        <div ref={wrapRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div ref={boardRef} className="relative" style={{ width: '100%' }}>
            <DraftImageLayer key={questionId} images={images} onImagesChange={updateImages} selectedIds={selectedImageIds} handlesEnabled={tool === 'select'} />
            {canvasEl}
          </div>
        </div>
      ) : (
        <div ref={wrapRef} className="flex-1 min-h-0 relative">
          <DraftImageLayer key={questionId} images={images} onImagesChange={updateImages} selectedIds={selectedImageIds} handlesEnabled={tool === 'select'} />
          {canvasEl}
        </div>
      )}
    </div>
  );
}
