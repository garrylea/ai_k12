/** 旋转中心候选点（纯几何，无 DOM/React，便于单测）。
 *
 *  为什么需要它：笔迹落笔即拍平成点列（没有形状对象），所以「矩形/三角形」要从点集反推——
 *  工具画的图形采样后，凸包恰好是 4 个（矩形）或 3 个（三角形）角点（共线点被单调链剔除），
 *  据此判定形状并取顶点；已旋转过的图形同样成立（凸包随图形转）。
 *  直线就是 2 个点的笔迹，候选点直接取两端与中点。
 *
 *  其它图形（椭圆/圆规圆/手写）凸包顶点数不对或点不贴边，返回 null，仍走"绕包围盒中心"。 */

export interface PivotCandidate {
  /** 仅用于 React key / 调试：**选中后存的是坐标不是这个标签**——图形转一次角度，顶点的"名字"可能换位 */
  id: string;
  x: number;
  y: number;
}

export interface ShapePivots {
  /** 可点选的旋转中心（第一个是默认中心，与 defaultCenter 同坐标） */
  candidates: PivotCandidate[];
  /** 不点任何候选点时的默认中心：直线中点 / 矩形中心 / 三角形重心。
   *  注意三角形的重心 ≠ 包围盒中心，所以默认中心必须由形状自己给出，不能一律取包围盒中心。 */
  defaultCenter: { x: number; y: number };
}

type Pt = { x: number; y: number };

/** 点离边的最远容忍距离（CSS px）：工具画的图形点严格在边上，留一点浮点/抗锯齿余量 */
const EDGE_TOL = 2.5;
/** 每条边上的最大空隙（占边长比例）：排除"缺一条边"的开口图形（U 形/V 形） */
const MAX_GAP_RATIO = 0.35;
/** 相邻边垂直度：|cos| ≤ 0.1 ≈ 偏离 90° 不超过 5.7°（工具画的矩形是精确直角） */
const RECT_COS_TOL = 0.1;
/** 少于这么多点不可能是工具画的闭合图形（采样步长 ~3px） */
const MIN_POLY_POINTS = 8;
/** 首尾点重合判定（px）：工具画的闭合图形末点回到起点 */
const CLOSED_TOL = 2;
/** 共线判定的数值容差（px²）：旋转后的点列会有 ~1e-13 的浮点抖动，
 *  不放容差会把这些点当成"凸包顶点"，4 角变 5~6 角就认不出图形了 */
const HULL_EPS = 1e-6;

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

/** 凸包（单调链）。剔除共线点 —— 曲线/斜边会留下很多顶点，矩形只剩 4 个角、三角形 3 个。 */
export function convexHull(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const lower: Pt[] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= HULL_EPS) lower.pop();
    lower.push(pt);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= HULL_EPS) upper.pop();
    upper.push(pt);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 首尾点重合、点数够多 —— 只有闭合图形才谈得上"点内部选中"和"取顶点当中心" */
function isClosed(points: ReadonlyArray<Pt>): boolean {
  if (points.length < MIN_POLY_POINTS) return false;
  const a = points[0];
  const b = points[points.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) <= CLOSED_TOL;
}

/** 所有点贴在多边形边上，且每条边都被点连续覆盖（最大空隙 ≤ MAX_GAP_RATIO 边长）。
 *  后者排除开口图形：U 形缺一条边时凸包同样是 4 点、点也全在周界上，只有按边看空隙才能识破。 */
function edgesFilled(points: ReadonlyArray<Pt>, corners: ReadonlyArray<Pt>): boolean {
  const n = corners.length;
  for (const p of points) {
    let best = Infinity;
    for (let i = 0; i < n; i++) best = Math.min(best, distToSegment(p, corners[i], corners[(i + 1) % n]));
    if (best > EDGE_TOL) return false;
  }
  for (let i = 0; i < n; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) return false;
    const ts: number[] = [];
    for (const p of points) {
      if (distToSegment(p, a, b) > EDGE_TOL) continue;
      ts.push(((p.x - a.x) * ex + (p.y - a.y) * ey) / len);
    }
    ts.sort((p, q) => p - q);
    let maxGap = ts.length ? Math.max(ts[0], len - ts[ts.length - 1]) : len;
    for (let k = 1; k < ts.length; k++) maxGap = Math.max(maxGap, ts[k] - ts[k - 1]);
    if (maxGap > len * MAX_GAP_RATIO) return false;
  }
  return true;
}

/** 四个角都是直角（叉积判垂直） */
function cornersAreRightAngles(corners: ReadonlyArray<Pt>): boolean {
  for (let i = 0; i < 4; i++) {
    const prev = corners[(i + 3) % 4];
    const cur = corners[i];
    const next = corners[(i + 1) % 4];
    const e1 = { x: prev.x - cur.x, y: prev.y - cur.y };
    const e2 = { x: next.x - cur.x, y: next.y - cur.y };
    const l1 = Math.hypot(e1.x, e1.y);
    const l2 = Math.hypot(e2.x, e2.y);
    if (l1 < 1e-6 || l2 < 1e-6) return false;
    if (Math.abs((e1.x * e2.x + e1.y * e2.y) / (l1 * l2)) > RECT_COS_TOL) return false;
  }
  return true;
}

function avg(pts: ReadonlyArray<Pt>): Pt {
  let x = 0;
  let y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

/** 矩形？是则返回 4 个角点（凸包顺序，可能顺/逆时针） */
export function rectangleCorners(points: ReadonlyArray<Pt>): Pt[] | null {
  if (!isClosed(points)) return null;
  const hull = convexHull(points as Pt[]);
  if (hull.length !== 4) return null;
  if (!cornersAreRightAngles(hull)) return null;
  if (!edgesFilled(points, hull)) return null;
  return hull;
}

/** 三角形？是则返回 3 个顶点 */
export function triangleCorners(points: ReadonlyArray<Pt>): Pt[] | null {
  if (!isClosed(points)) return null;
  const hull = convexHull(points as Pt[]);
  if (hull.length !== 3) return null;
  if (!edgesFilled(points, hull)) return null;
  return hull;
}

/** 笔迹的旋转中心候选点：
 *  直线 3 个（两端 + 中点，默认中点）；矩形 5 个（中心 + 四角，默认中心）；三角形 4 个（重心 + 三个顶点，默认重心）。
 *  其它图形返回 null（仍绕包围盒中心）。 */
export function strokePivots(points: ReadonlyArray<Pt>): ShapePivots | null {
  if (points.length === 2) {
    const [a, b] = points;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return {
      candidates: [
        { id: 'mid', x: mid.x, y: mid.y },
        { id: 'start', x: a.x, y: a.y },
        { id: 'end', x: b.x, y: b.y },
      ],
      defaultCenter: mid,
    };
  }

  const tri = triangleCorners(points);
  if (tri) {
    const center = avg(tri); // 三角形重心 = 三个顶点平均（面积重心，斜三角形上 ≠ 包围盒中心）
    return {
      candidates: [
        { id: 'center', x: center.x, y: center.y },
        ...tri.map((p, i) => ({ id: `vertex-${i}`, x: p.x, y: p.y })),
      ],
      defaultCenter: center,
    };
  }

  const rect = rectangleCorners(points);
  if (rect) {
    const center = avg(rect);
    return {
      candidates: [
        { id: 'center', x: center.x, y: center.y },
        ...rect.map((p, i) => ({ id: `corner-${i}`, x: p.x, y: p.y })),
      ],
      defaultCenter: center,
    };
  }

  return null;
}

/** 命中候选点：取最近的（短线/小图形上几个点挨得近，不能永远命中排在前面的那个） */
export function nearestPivot(
  pivots: ReadonlyArray<PivotCandidate>,
  x: number,
  y: number,
  hitRadius: number,
): PivotCandidate | null {
  let best: PivotCandidate | null = null;
  let bestD = Infinity;
  for (const p of pivots) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= hitRadius && d < bestD) { best = p; bestD = d; }
  }
  return best;
}
