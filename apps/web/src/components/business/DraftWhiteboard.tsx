import { useEffect, useRef, useState, useCallback } from 'react';
import { useThemeStore } from '@/store/themeStore';
import {
  getDraft, setDraft, getDraftImages, setDraftImages,
  type Stroke, type DraftImage, type DraftPoint,
} from './draft-store';
import {
  initHistory, pushState, undo as undoHistory, redo as redoHistory, canUndo, canRedo,
  type DraftState,
} from './draft-history';
import {
  type CompassState, angleAt, handlePos, hitHandle, normalizeAngle, sampleArc, sampleCircle,
  MIN_R, DEFAULT_R, TAP_SLOP, MIN_SWEEP,
} from './draft-compass';
import { DraftImageLayer } from './DraftImageLayer';
import { fileToDraftImage, draftImageFromSrc, isEditableTarget } from './draft-image-utils';
import { registerDropTarget } from './draft-image-drag';
import { strokePivots, nearestPivot, type PivotCandidate } from './draft-shape-pivots';

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

/** 橡皮命中容差（CSS px）：笔迹基准线宽之外再放宽 8px（沿用原 `size + 8`，宽松好擦）。
 *  注意：这是「够不够得着」的擦除手感，不要拿它当选中起手的容差，见下。 */
const ERASER_HIT_SLOP = 8;

/** 选中工具的起手命中容差（CSS px）：从墨迹边缘只外扩 3px（手写笔线宽 2px → 共 4px 判定）。
 *  起手判定要严格：手写笔迹短促密集，容差一宽（曾与橡皮共用 10px），贴着笔画拖框会被判成
 *  「抓住这条笔画」，整个手势变成拖动那条笔画，框选矩形根本不出现、一条笔迹也框不住。
 *  橡皮的宽松判定不受影响。 */
const SELECT_HIT_SLOP = 3;

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

/** 是否命中某条笔迹：点到笔迹中心线的最近距离 ≤ threshold。
 *  容差由调用方给，两处语义不同：
 *  - 橡皮：`stroke.size + ERASER_HIT_SLOP`（宽松，好擦）；
 *  - 选中起手（点选/起手拖框）：`stroke.size / 2 + SELECT_HIT_SLOP`（严格，见常量注释）。 */
function hitStroke(stroke: Stroke, x: number, y: number, threshold: number): boolean {
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

/** 深拷贝单条笔迹（点对象与圆心标记都新建）。
 *  写时复制用：已经进了历史快照的 Stroke 视为只读，原地改坐标的手势必须先克隆。 */
function cloneStroke(s: Stroke): Stroke {
  return {
    ...s,
    points: s.points.map((p) => ({ ...p })),
    ...(s.center ? { center: { ...s.center } } : {}),
  };
}

/** 选中笔迹的并集包围盒（null = 没有选中笔迹） */
function unionStrokeBounds(sel: Iterable<Stroke>): { x0: number; y0: number; x1: number; y1: number } | null {
  let out: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const s of sel) {
    const b = strokeBounds(s);
    if (!out) out = { ...b };
    else {
      out.x0 = Math.min(out.x0, b.x0);
      out.y0 = Math.min(out.y0, b.y0);
      out.x1 = Math.max(out.x1, b.x1);
      out.y1 = Math.max(out.y1, b.y1);
    }
  }
  return out;
}

/** 旋转手柄：默认在选区上方 26px；上方空间不足（y0 < 48）时放到下方，避免顶出画布抓不到 */
const ROTATE_HANDLE_GAP = 26;
const ROTATE_HANDLE_R = 6;
/** 命中半径 20px：iPad 手指够得着（本体只有 12px 直径） */
const ROTATE_HANDLE_HIT = 20;
/** Shift 吸附步长 15° */
const ROTATE_SNAP = Math.PI / 12;
/** 小于 0.5° 视为没有旋转（不记历史、不落盘） */
const MIN_ROTATE_ANGLE = Math.PI / 360;
/** 选中移动的净位移下限（px）：拖出去又拖回原位（净位移小于它）不算一次移动，不记历史 */
const MIN_MOVE_PX = 0.5;

interface RotateHandle {
  x: number;
  y: number;
  /** 连线接在包围盒的哪条边（上方手柄接 y0，下方手柄接 y1） */
  edgeY: number;
  below: boolean;
}

function rotateHandleFor(b: { x0: number; y0: number; x1: number; y1: number }): RotateHandle {
  const cx = (b.x0 + b.x1) / 2;
  return b.y0 >= 48
    ? { x: cx, y: b.y0 - ROTATE_HANDLE_GAP, edgeY: b.y0 - 4, below: false }
    : { x: cx, y: b.y1 + ROTATE_HANDLE_GAP, edgeY: b.y1 + 4, below: true };
}

function hitRotateHandle(b: { x0: number; y0: number; x1: number; y1: number }, x: number, y: number): boolean {
  const h = rotateHandleFor(b);
  return Math.hypot(h.x - x, h.y - y) <= ROTATE_HANDLE_HIT;
}

/** 旋转中心的候选点与命中判定在 `draft-shape-pivots.ts`（纯几何）：
 *  直线 = 两端 + 中点，矩形 = 中心 + 四角，其它图形没有候选（仍绕选区包围盒中心）。
 *  中心点是**空间中的一个点**，不是图形上的锚：绕端点/角点转时该点不动。 */
/** 候选点视觉半径 / 命中半径（CSS px）：命中比视觉大一倍多，手指点得着 */
const PIVOT_DOT_R = 4.5;
const PIVOT_HIT = 16;

/** 单选的那一条笔迹（空选/多选返回 null）：只有单选时才有"可调中心"这回事 */
function singleSelectedStroke(sel: ReadonlySet<Stroke>): Stroke | null {
  if (sel.size !== 1) return null;
  const [only] = sel;
  return only;
}

interface RotateGesture {
  kind: 'rotate';
  cx: number;
  cy: number;
  /** 起手极角 */
  a0: number;
  /** 当前累计角（rad，已吸附） */
  total: number;
  items: Array<{
    stroke: Stroke;
    /** 起手时的点坐标（每帧从它重算，避免逐帧累积误差） */
    ox: number[];
    oy: number[];
    oc?: { x: number; y: number };
  }>;
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

const UndoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h9a6 6 0 0 1 0 12h-3" />
  </svg>
);

const RedoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9h-9a6 6 0 0 0 0 12h3" />
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
 * 选中层（仅 select 工具激活时叠加）：选中元素（笔画/贴图）的虚线包围盒 + 框选拖拽矩形
 * + 选区旋转手柄（纯贴图选区不画，贴图不参与旋转）。
 * 笔画平移/旋转改的是「起手时克隆出来的副本」的点列坐标（原位改写，不建新数组）——
 * 历史快照里的元素对象只读，撤销靠的就是它们不被改动，所以起手必须先克隆。
 * 包围盒每次重绘现算——单笔画点列最多千级，开销可忽略。
 */
function drawSelectionOverlay(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  selectedStrokes: ReadonlySet<Stroke>,
  images: DraftImage[],
  selectedImageIds: ReadonlySet<string>,
  marquee: { startX: number; startY: number; x: number; y: number } | null,
  rotate: {
    handle: RotateHandle;
    deg: number | null;
    /** 旋转中心候选点（null = 当前选区不支持改中心） */
    pivots: PivotCandidate[] | null;
    /** 当前生效的中心点坐标（默认选区中心；点选候选点后就是那个点） */
    activePivot: { x: number; y: number } | null;
  } | null,
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
  if (rotate) {
    const { handle, deg, pivots, activePivot } = rotate;
    const bg = (getComputedStyle(canvas).getPropertyValue('--learn-card-bg') || '#fff').trim();
    ctx.strokeStyle = brand;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    // 连线：从包围盒边缘接到旋钮
    ctx.beginPath();
    ctx.moveTo(handle.x, handle.edgeY);
    ctx.lineTo(handle.x, handle.below ? handle.y - ROTATE_HANDLE_R : handle.y + ROTATE_HANDLE_R);
    ctx.stroke();
    // 旋钮：实心圆 + 中心小孔（视觉上像可抓的把手，与普通控制点区分）
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, ROTATE_HANDLE_R, 0, Math.PI * 2);
    ctx.fillStyle = brand;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = bg;
    ctx.fill();
    // 中心点候选：空心圆 = 可选，实心带小孔 = 当前生效（与旋钮同款但要小一号，别抢焦点）。
    // 用坐标比对而不是候选 id：矩形转过一次后角点的"名字"会换位，坐标不会。
    if (pivots) {
      for (const p of pivots) {
        const active = !!activePivot && Math.hypot(p.x - activePivot.x, p.y - activePivot.y) < 0.75;
        ctx.beginPath();
        ctx.arc(p.x, p.y, PIVOT_DOT_R, 0, Math.PI * 2);
        ctx.fillStyle = active ? brand : bg;
        ctx.fill();
        ctx.strokeStyle = brand;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (active) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = bg;
          ctx.fill();
        }
      }
    }
    if (deg !== null) {
      ctx.fillStyle = (getComputedStyle(canvas).getPropertyValue('--text-tertiary') || '#999').trim();
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${Math.round(deg)}°`, handle.x + 10, handle.y - 10);
    }
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
  /** 本次橡皮手势是否真的擦掉过笔画（一次划过擦多条只记一步历史） */
  const eraserDirtyRef = useRef(false);
  /** 橡皮拖拽进行中（按下未抬手）：供 gestureBusy 判断，拖拽途中不响应撤销 */
  const eraserActiveRef = useRef(false);
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
  // 笔画选中框画在 canvas 上（redraw 读 ref），无需 state。手势态：拖动移动 / 空白框选 / 旋转手柄，
  // 拖动带图片原位快照（按手势起点绝对定位，防逐帧增量取整漂移）
  const [selectedImageIds, setSelectedImageIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const selectedStrokesRef = useRef<Set<Stroke>>(new Set());
  const selectedImageIdsRef = useRef<Set<string>>(new Set());
  const selectGestureRef = useRef<
    | { kind: 'move'; startX: number; startY: number; lastX: number; lastY: number; moved: boolean; pivotPick: { x: number; y: number } | null; origImages: Map<string, { x: number; y: number }> }
    | { kind: 'marquee'; startX: number; startY: number; x: number; y: number }
    | RotateGesture
    | null
  >(null);
  /** 旋转中心的选择：记住「哪条笔迹 + 哪个空间坐标点」。
   *  用坐标而不是候选点编号：矩形转过一次后角点的编号会换位，坐标点不会（绕角点转时该点本来就不动）。
   *  用 stroke 对象做身份：选区换了另一条笔迹就自动失配、退回默认中心；
   *  移动/旋转会克隆笔迹，那两个手势里会把它改挂到克隆上，否则转一次中心就丢。 */
  const rotatePivotRef = useRef<{ stroke: Stroke; x: number; y: number } | null>(null);
  const themeMode = useThemeStore((s) => s.mode);
  /** 拖拽悬停在画布上：落点高亮（拖进草稿时让学生看见「松手会放这里」） */
  const [dropHover, setDropHover] = useState(false);

  // 切题竞态防护：在途图片解码（FileReader/Image，几百 ms）期间切题，放弃插入避免污染新题视图/覆写旧题 store
  const questionIdRef = useRef(questionId);
  useEffect(() => { questionIdRef.current = questionId; }, [questionId]);

  /** 只用第二个返回值触发重渲染：历史本体在模块级 Map，按钮可用态渲染时现算（canUndo/canRedo） */
  const [, bumpHistory] = useState(0);

  /** 记一步：内容与当前态相同（引用全同）时 pushState 返回 false，按钮不会误亮 */
  const pushHistory = useCallback(() => {
    if (pushState(questionId, { strokes: strokesRef.current, images: imagesRef.current })) {
      bumpHistory((v) => v + 1);
    }
  }, [questionId]);

  const flushEraserHistory = useCallback(() => {
    if (!eraserDirtyRef.current) return;
    eraserDirtyRef.current = false;
    pushHistory();
  }, [pushHistory]);

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
      const selB = selectedStrokesRef.current.size ? unionStrokeBounds(selectedStrokesRef.current) : null;
      // 单选的直线/矩形给出候选中心点；选了哪个点记在 ref 里（换笔迹自动失配 → 退回默认中心）
      const only = singleSelectedStroke(selectedStrokesRef.current);
      const pivots = only ? strokePivots(only.points) : null;
      const choice = rotatePivotRef.current;
      const activePivot = only && choice && choice.stroke === only
        ? { x: choice.x, y: choice.y }
        : selB ? { x: (selB.x0 + selB.x1) / 2, y: (selB.y0 + selB.y1) / 2 } : null;
      drawSelectionOverlay(
        ctx, canvas, selectedStrokesRef.current, imagesRef.current, selectedImageIdsRef.current,
        g && g.kind === 'marquee' ? g : null,
        selB
          ? {
              handle: rotateHandleFor(selB),
              deg: g && g.kind === 'rotate' ? (g.total * 180) / Math.PI : null,
              pivots,
              activePivot,
            }
          : null,
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
    let inserted = 0;
    for (let i = 0; i < files.length; i++) {
      const img = await fileToDraftImage(files[i], wrap.clientWidth, viewport);
      if (questionIdRef.current !== currentQ) return; // 切题了，放弃在途插入（不记历史，避免把新题状态写进旧题）
      if (i > 0) { img.x += i * 16; img.y += i * 16; }
      updateImages((prev) => [...prev, img]);
      inserted += 1;
    }
    if (inserted > 0) pushHistory();
  }, [scrollMode, updateImages, pushHistory]);

  /** 题干图拖入：按松手点插入一张贴图（落点是贴图中心），一次拖入记一步历史 */
  const insertImageFromSrc = useCallback(async (src: string, at: { x: number; y: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const currentQ = questionIdRef.current;
    let img: DraftImage;
    try {
      img = await draftImageFromSrc(src, canvas.clientWidth, canvas.clientHeight, at);
    } catch {
      console.warn('[draft] 图片解码失败，已跳过', src);
      return;
    }
    if (questionIdRef.current !== currentQ) return; // 切题了：丢弃在途插入
    updateImages((prev) => [...prev, img]);
    pushHistory();
  }, [updateImages, pushHistory]);

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
    const stroke: Stroke = center ? { points, size: INK_WIDTH, center } : { points, size: INK_WIDTH };
    // 追加必须换新数组：原地 push 会连历史快照里的同一个数组一起改，撤销就「没反应」了
    strokesRef.current = [...strokesRef.current, stroke];
    if (persist) setDraft(questionId, strokesRef.current);
    redraw();
    pushHistory();
  }, [persist, questionId, redraw, pushHistory]);

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

  /** 贴图四角缩放进行中（DraftImageLayer 内部手势，父级只能靠回调感知） */
  const imageResizeRef = useRef(false);
  /** 有手势在进行时不响应撤销（否则会把半截手势写进历史） */
  const gestureBusy = useCallback(() => (
    drawingRef.current
    || eraserActiveRef.current
    || imageResizeRef.current
    || selectGestureRef.current !== null
    || shapeGestureRef.current !== null
    || triDragRef.current !== null
    || compassRef.current.phase === 'placing'
    || compassRef.current.phase === 'resizing'
    || compassRef.current.phase === 'drawing'
  ), []);

  /** 把历史快照写回视图与 store；选区必须清空——快照里是另一批对象引用 */
  const applyHistoryState = useCallback((snap: DraftState) => {
    strokesRef.current = snap.strokes;
    imagesRef.current = snap.images;
    setImages(snap.images);
    if (persist) {
      setDraft(questionId, snap.strokes);
      setDraftImages(questionId, snap.images);
    }
    setSelection(new Set(), new Set());
  }, [persist, questionId, setSelection]);

  const doUndo = useCallback(() => {
    if (gestureBusy()) return;
    const snap = undoHistory(questionId);
    if (!snap) return;
    applyHistoryState(snap);
    bumpHistory((v) => v + 1);
  }, [gestureBusy, questionId, applyHistoryState]);

  const doRedo = useCallback(() => {
    if (gestureBusy()) return;
    const snap = redoHistory(questionId);
    if (!snap) return;
    applyHistoryState(snap);
    bumpHistory((v) => v + 1);
  }, [gestureBusy, questionId, applyHistoryState]);

  /** 命中检测：笔画优先（canvas 恒绘制在贴图之上，视觉上层先命中），均从末位（最上层）向前找。
   *  笔迹用严格的起手容差（SELECT_HIT_SLOP）——宽判定会把「拖框框选」抢成「抓住这条笔画」。 */
  const hitElement = (x: number, y: number): { stroke: Stroke } | { imageId: string } | null => {
    for (let i = strokesRef.current.length - 1; i >= 0; i--) {
      const s = strokesRef.current[i];
      if (hitStroke(s, x, y, s.size / 2 + SELECT_HIT_SLOP)) return { stroke: s };
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

  /** 起手旋转：先克隆选中笔迹（写时复制），再改克隆——历史快照里的旧对象必须保持不变 */
  const startRotate = (x: number, y: number, b: { x0: number; y0: number; x1: number; y1: number }) => {
    // 中心点：单选一条笔迹且点选过候选点就用它，否则沿用选区包围盒中心
    const only = singleSelectedStroke(selectedStrokesRef.current);
    const choice = rotatePivotRef.current;
    const chosen = only && choice && choice.stroke === only ? { x: choice.x, y: choice.y } : null;
    const cx = chosen ? chosen.x : (b.x0 + b.x1) / 2;
    const cy = chosen ? chosen.y : (b.y0 + b.y1) / 2;
    const cloneOf = new Map<Stroke, Stroke>();
    const items: RotateGesture['items'] = [];
    for (const s of selectedStrokesRef.current) {
      const clone = cloneStroke(s);
      cloneOf.set(s, clone);
      items.push({
        stroke: clone,
        ox: s.points.map((p) => p.x),
        oy: s.points.map((p) => p.y),
        oc: s.center ? { x: s.center.x, y: s.center.y } : undefined,
      });
    }
    strokesRef.current = strokesRef.current.map((s) => cloneOf.get(s) ?? s);
    // 克隆把对象换了：中心点选择要改挂到克隆上，否则转一次就退回默认中心
    if (only && chosen) {
      const clone = cloneOf.get(only);
      rotatePivotRef.current = clone ? { stroke: clone, x: chosen.x, y: chosen.y } : null;
    }
    setSelection(new Set(items.map((it) => it.stroke)), new Set(selectedImageIdsRef.current));
    selectGestureRef.current = { kind: 'rotate', cx, cy, a0: angleAt(cx, cy, x, y), total: 0, items };
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'grabbing';
  };

  const selectDown = (x: number, y: number, shiftKey: boolean) => {
    // 旋转手柄的命中优先于元素命中：手柄常常压在选择框外/贴图上方，否则会变成拖走底下那条笔画
    const selBounds = selectedStrokesRef.current.size ? unionStrokeBounds(selectedStrokesRef.current) : null;
    if (selBounds && hitRotateHandle(selBounds, x, y)) {
      startRotate(x, y, selBounds);
      return;
    }
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
    // 移动会原地改点坐标：起手先克隆选中笔迹，历史快照里的旧对象保持不动。
    // 点选后没位移（g.moved 为 false）不记历史；克隆坐标与旧对象完全相同，视觉无差异。
    const cloneOf = new Map<Stroke, Stroke>();
    for (const s of selectedStrokesRef.current) cloneOf.set(s, cloneStroke(s));
    if (cloneOf.size) {
      strokesRef.current = strokesRef.current.map((s) => cloneOf.get(s) ?? s);
      selectedStrokesRef.current = new Set(cloneOf.values());
      // 中心点选择跟着克隆搬，移动之后还绕原来那个点转
      const pivotChoice = rotatePivotRef.current;
      const pivotClone = pivotChoice ? cloneOf.get(pivotChoice.stroke) : undefined;
      if (pivotChoice && pivotClone) {
        rotatePivotRef.current = { stroke: pivotClone, x: pivotChoice.x, y: pivotChoice.y };
      }
    }
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'grabbing';
    // 图片原位快照——按手势起点绝对定位，避免逐帧增量取整漂移
    const origImages = new Map(
      imagesRef.current
        .filter((im) => selectedImageIdsRef.current.has(im.id))
        .map((im) => [im.id, { x: im.x, y: im.y }] as const),
    );
    // 中心候选点压在图形上：按下时先记下「可能是在点中心」，
    // 抬手时按有没有位移分流——点一下换中心，拖动照常移动（否则中点那 32px 会吃掉“抓住图形拖走”）
    const only = singleSelectedStroke(selectedStrokesRef.current);
    const candidates = only ? strokePivots(only.points) : null;
    const picked = candidates ? nearestPivot(candidates, x, y, PIVOT_HIT) : null;
    const pivotPick = picked ? { x: picked.x, y: picked.y } : null;
    selectGestureRef.current = { kind: 'move', startX: x, startY: y, lastX: x, lastY: y, moved: false, pivotPick, origImages };
  };

  const selectMove = (x: number, y: number, shiftKey: boolean) => {
    const g = selectGestureRef.current;
    const canvas = canvasRef.current;
    if (!g) {
      // 悬停：落在中心候选点/选中包围盒/旋转手柄上给抓取提示（直接改 DOM 不走 React，避免逐帧重渲染）
      if (canvas) {
        const b = selectedStrokesRef.current.size ? unionStrokeBounds(selectedStrokesRef.current) : null;
        const only = singleSelectedStroke(selectedStrokesRef.current);
        const candidates = only ? strokePivots(only.points) : null;
        if (candidates && nearestPivot(candidates, x, y, PIVOT_HIT)) canvas.style.cursor = 'pointer';
        else canvas.style.cursor = (b && hitRotateHandle(b, x, y)) || insideSelectionBounds(x, y) ? 'grab' : 'default';
      }
      return;
    }
    if (g.kind === 'marquee') {
      g.x = x; g.y = y;
      redraw();
      return;
    }
    if (g.kind === 'rotate') {
      // 累积角从起手极角算（normalizeAngle 取最短角差）——不是逐帧累加，指针绕一圈也不会自增 360°
      const raw = normalizeAngle(angleAt(g.cx, g.cy, x, y) - g.a0);
      const total = shiftKey ? Math.round(raw / ROTATE_SNAP) * ROTATE_SNAP : raw;
      g.total = total;
      const cos = Math.cos(total);
      const sin = Math.sin(total);
      for (const it of g.items) {
        for (let i = 0; i < it.stroke.points.length; i++) {
          const dx = it.ox[i] - g.cx;
          const dy = it.oy[i] - g.cy;
          it.stroke.points[i].x = g.cx + dx * cos - dy * sin;
          it.stroke.points[i].y = g.cy + dx * sin + dy * cos;
        }
        if (it.stroke.center && it.oc) {
          const dx = it.oc.x - g.cx;
          const dy = it.oc.y - g.cy;
          it.stroke.center.x = g.cx + dx * cos - dy * sin;
          it.stroke.center.y = g.cy + dx * sin + dy * cos;
        }
      }
      redraw();
      return;
    }
    if (canvas) canvas.style.cursor = 'grabbing';
    const dx = x - g.lastX;
    const dy = y - g.lastY;
    if (dx === 0 && dy === 0) return;
    g.moved = true;
    g.lastX = x; g.lastY = y;
    // 笔画：点列原位平移（浮点增量，无取整误差；圆心标记随之一并平移）；
    // 贴图：快照 + 总位移绝对定位（负方向夹 0）
    for (const s of selectedStrokesRef.current) {
      for (const p of s.points) { p.x += dx; p.y += dy; }
      if (s.center) { s.center.x += dx; s.center.y += dy; }
    }
    // 旋转中心是空间点，得跟着图形一起平移，否则移动后中心落在旧位置
    const pivotChoice = rotatePivotRef.current;
    if (pivotChoice && selectedStrokesRef.current.has(pivotChoice.stroke)) {
      pivotChoice.x += dx;
      pivotChoice.y += dy;
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
    if (g.kind === 'rotate') {
      // 微小角度（< 0.5°）是按下时的抖动，不算一次旋转：不落盘、不记历史（否则撤销栈被空步挤占）
      if (Math.abs(g.total) >= MIN_ROTATE_ANGLE) {
        if (persist) setDraft(questionId, strokesRef.current);
        pushHistory();
      }
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = 'default';
      redraw();
      return;
    }
    if (g.kind === 'move') {
      // 没位移又按在中心候选点上：这次手势是「选旋转中心」，不落盘、不记历史
      if (!g.moved && g.pivotPick) {
        const only = singleSelectedStroke(selectedStrokesRef.current);
        if (only) rotatePivotRef.current = { stroke: only, x: g.pivotPick.x, y: g.pivotPick.y };
        redraw();
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = 'pointer';
        return;
      }
      if (g.moved) {
        if (persist) setDraft(questionId, strokesRef.current); // 笔画平移落盘（贴图已随 updateImages 逐帧落盘）
        // 只有净位移够大才记历史：拖出去又拖回原位是空步，记了会让撤销「看起来没反应」
        if (Math.hypot(x - g.startX, y - g.startY) >= MIN_MOVE_PX) pushHistory();
      }
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

  // 选中手势收尾（系统打断/丢失捕获/两指平移接管）：移动按当前位置落盘，框选丢弃，旋转按当前角度落定
  const cancelSelect = () => {
    const g = selectGestureRef.current;
    if (!g) return;
    selectGestureRef.current = null;
    if (g.kind === 'rotate') {
      if (Math.abs(g.total) >= MIN_ROTATE_ANGLE) {
        if (persist) setDraft(questionId, strokesRef.current);
        pushHistory();
      }
      redraw();
      return;
    }
    if (g.kind === 'move' && g.moved) {
      if (persist) setDraft(questionId, strokesRef.current);
      // 同上：抬手（此处是最后一帧位置）净位移不足时是空步，不记历史
      if (Math.hypot(g.lastX - g.startX, g.lastY - g.startY) >= MIN_MOVE_PX) pushHistory();
    }
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

  // 拖拽落点 = canvas（画布坐标系原点）；注销函数随卸载调用
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return registerDropTarget({
      el: canvas,
      onHover: setDropHover,
      onDrop: (src, pt) => { void insertImageFromSrc(src, pt); },
    });
  }, [insertImageFromSrc]);

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
    // 历史登记初始态：必须在任何 pushState 之前，否则第一笔会被当成初始态、撤销不到空板
    initHistory(questionId, { strokes: strokesRef.current, images: imagesRef.current });
    bumpHistory((v) => v + 1);
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
    strokesRef.current = strokesRef.current.filter((s) => !hitStroke(s, x, y, s.size + ERASER_HIT_SLOP));
    if (strokesRef.current.length !== before) {
      eraserDirtyRef.current = true;
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
        eraserActiveRef.current = false; // 平移接管橡皮拖拽：撤销不再被这个手势挡住（脏标记留给抬手冲）
        return;
      }
      if (panRef.current) return; // 平移中（第三指及以上）：仅记录，不再起笔
    }
    const p = pointFromEvent(e);
    if (tool === 'eraser') {
      eraserActiveRef.current = true; // 拖拽开始：eraseAt 在 move 里持续擦，手势期间不响应撤销
      eraserDirtyRef.current = false; // 新手势：之前的脏标记已在抬手/取消时冲掉
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
      strokesRef.current = [...strokesRef.current, { points: [p], size: DOT_SIZE }];
      if (persist) setDraft(questionId, strokesRef.current);
      redraw();
      return;
    }
    drawingRef.current = true;
    // 追加必须换新数组（写时复制）：原地 push 会连历史快照里的同一个数组一起改，撤销就「没反应」了
    strokesRef.current = [...strokesRef.current, { points: [p], size: INK_WIDTH }];
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
      selectMove(p.x, p.y, e.shiftKey); // 非手势态内部 no-op
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
    if (tool === 'eraser') { eraserActiveRef.current = false; flushEraserHistory(); return; }
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
    pushHistory();
  };

  // 系统打断（来电/手势接管）或捕获丢失：指针从表中移除；中断单指笔迹不落盘、圆规/选中手势收尾
  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    endPointer(e);
    drawingRef.current = false;
    eraserActiveRef.current = false; // 系统打断橡皮拖拽：手势结束，撤销恢复可用
    flushEraserHistory(); // 对无橡皮手势幂等
    cancelCompass();
    cancelSelect();
    cancelShape();
    if (triDragRef.current !== null) triangleUp(); // 顶点拖拽固定当前位置（不丢已放的三角形）
  };
  const handleLostPointerCapture = (e: React.PointerEvent<HTMLCanvasElement>) => {
    endPointer(e);
    eraserActiveRef.current = false; // 捕获丢失等同抬手：橡皮手势结束
    flushEraserHistory(); // 对无橡皮手势幂等
    cancelCompass(); // 正常抬手后此事件仍会触发，各 cancel 对无手势态幂等
    cancelSelect();
    cancelShape();
    if (triDragRef.current !== null) triangleUp();
  };

  const handleClear = () => {
    strokesRef.current = [];
    imagesRef.current = [];
    setImages([]);
    if (persist) { setDraft(questionId, []); setDraftImages(questionId, []); }
    updateCompass({ phase: 'idle' }); // 圆规一并重置（含重绘）
    shapeGestureRef.current = null;
    resetTriangle();
    selectGestureRef.current = null;
    setSelection(new Set(), new Set());
    pushHistory();
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
      pushHistory();
      setSelection(new Set(), new Set());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tool, persist, questionId, updateImages, setSelection, pushHistory]);

  // 撤销/重做全局快捷键：Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z、Ctrl+Y。
  // 不绑 Ctrl+R —— 它是浏览器/Electron 的刷新，误触会整页重载、内存草稿全丢。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;       // 在输入框里要撤销文字
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
      if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); doRedo(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo]);

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
        {toolBtn('select', '选中（点选/框选，拖动移动，上方手柄旋转，Delete 删除）', <SelectIcon />)}
        <div className="flex-1" />
        <button
          onClick={doUndo}
          disabled={!canUndo(questionId)}
          title="撤销（Ctrl+Z）"
          aria-label="撤销（Ctrl+Z）"
          className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[var(--learn-card-bg)]"
        >
          <UndoIcon />
        </button>
        <button
          onClick={doRedo}
          disabled={!canRedo(questionId)}
          title="重做（Ctrl+Shift+Z）"
          aria-label="重做（Ctrl+Shift+Z）"
          className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[var(--learn-card-bg)]"
        >
          <RedoIcon />
        </button>
        <button
          onClick={handleClear}
          title="清空草稿"
          aria-label="清空草稿"
          className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)] transition-colors"
        >
          <TrashIcon />
        </button>
      </div>
      {/* 画布区：相对定位容器——圆规/三角形的状态提示与操作以浮条压在其顶部。
          浮条不占布局高度，所以切工具、切换状态时画布尺寸不变，草稿区不会跳动。 */}
      <div
        className="flex-1 min-h-0 relative"
        style={dropHover ? { boxShadow: 'inset 0 0 0 2px var(--brand-500)' } : undefined}
      >
        {/* 圆规浮条：状态提示 + 半径读数 + 整圆/重置 */}
        {tool === 'compass' && (
          <div
            className="absolute top-2 left-2 right-2 z-20 flex items-center gap-2 rounded-lg border border-[var(--bg-subtle)] px-2.5 py-1.5 text-xs text-[var(--text-tertiary)]"
            style={{ backgroundColor: 'var(--learn-card-bg)', boxShadow: 'var(--shadow-card)' }}
          >
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
        {/* 三角形浮条：状态提示 + 确认/重置（三点齐后才可确认） */}
        {tool === 'triangle' && (
          <div
            className="absolute top-2 left-2 right-2 z-20 flex items-center gap-2 rounded-lg border border-[var(--bg-subtle)] px-2.5 py-1.5 text-xs text-[var(--text-tertiary)]"
            style={{ backgroundColor: 'var(--learn-card-bg)', boxShadow: 'var(--shadow-card)' }}
          >
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
          <div ref={wrapRef} className="absolute inset-0 overflow-y-auto overflow-x-hidden">
            <div ref={boardRef} className="relative" style={{ width: '100%' }}>
              <DraftImageLayer key={questionId} images={images} onImagesChange={updateImages} selectedIds={selectedImageIds} handlesEnabled={tool === 'select'} onCommit={pushHistory} onGestureChange={(active) => { imageResizeRef.current = active; }} />
              {canvasEl}
            </div>
          </div>
        ) : (
          <div ref={wrapRef} className="absolute inset-0">
            <DraftImageLayer key={questionId} images={images} onImagesChange={updateImages} selectedIds={selectedImageIds} handlesEnabled={tool === 'select'} onCommit={pushHistory} onGestureChange={(active) => { imageResizeRef.current = active; }} />
            {canvasEl}
          </div>
        )}
      </div>
    </div>
  );
}
