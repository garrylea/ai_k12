/** 旋转中心候选点（纯几何，无 DOM/React，便于单测）。
 *
 *  为什么需要它：笔迹落笔即拍平成点列（没有形状对象），所以「矩形」要从点集反推——
 *  工具画的矩形采样后，凸包恰好是 4 个角点（共线点被单调链剔除），据此判定矩形并取角点；
 *  已旋转过的矩形同样成立（凸包随图形转，仍是 4 个角）。
 *  直线就是 2 个点的笔迹，候选点直接取两端与中点。
 *
 *  其它图形（椭圆/三角形/圆规圆/手写）凸包不是 4 点或点不贴边，返回 null，仍走"绕包围盒中心"。 */

export interface PivotCandidate {
  /** 仅用于 React key / 调试：**选中后存的是坐标不是这个标签**——矩形转一次角度，角点的"名字"可能换位 */
  id: string;
  x: number;
  y: number;
}

type Pt = { x: number; y: number };

/** 点离矩形边的最远容忍距离（CSS px）：工具画的矩形点严格在边上，留一点浮点/抗锯齿余量 */
const RECT_EDGE_TOL = 2.5;
/** 相邻边垂直度：|cos| ≤ 0.1 ≈ 偏离 90° 不超过 5.7°（工具画的矩形是精确直角） */
const RECT_COS_TOL = 0.1;
/** 少于这么多点不可能是工具画的矩形（采样步长 ~3px，最小矩形也有几十个点） */
const RECT_MIN_POINTS = 8;

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

/** 共线判定的数值容差（px²）：旋转后的点列会有 ~1e-13 的浮点抖动，
 *  不放容差会把这些点当成"凸包顶点"，4 角变 5~6 角就认不出矩形了 */
const HULL_EPS = 1e-6;

/** 凸包（单调链）。剔除共线点 —— 曲线/斜边会留下很多顶点，矩形只剩 4 个角。 */
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

/** 点集是不是一个矩形？是则返回 4 个角点（顺序为凸包顺序，可能是顺时针也可能是逆时针）。 */
export function rectangleCorners(points: ReadonlyArray<Pt>): Pt[] | null {
  if (points.length < RECT_MIN_POINTS) return null;
  const hull = convexHull(points as Pt[]);
  if (hull.length !== 4) return null;

  // 四个角都必须是直角（叉积判垂直，等价于相邻边单位向量点积 ≈ 0）
  for (let i = 0; i < 4; i++) {
    const prev = hull[(i + 3) % 4];
    const cur = hull[i];
    const next = hull[(i + 1) % 4];
    const e1 = { x: prev.x - cur.x, y: prev.y - cur.y };
    const e2 = { x: next.x - cur.x, y: next.y - cur.y };
    const l1 = Math.hypot(e1.x, e1.y);
    const l2 = Math.hypot(e2.x, e2.y);
    if (l1 < 1e-6 || l2 < 1e-6) return null;
    if (Math.abs((e1.x * e2.x + e1.y * e2.y) / (l1 * l2)) > RECT_COS_TOL) return null;
  }

  // 所有点都要贴在四条边上：否则是"凸包刚好 4 点但形状不是矩形"（折线、开口图形等）
  for (const p of points) {
    let best = Infinity;
    for (let i = 0; i < 4; i++) best = Math.min(best, distToSegment(p, hull[i], hull[(i + 1) % 4]));
    if (best > RECT_EDGE_TOL) return null;
  }

  // 每条边都要有连续的点：开口的 U 形（缺一条边）凸包同样是 4 点、点也全在周界上，
  // 只有按边看"最大空隙"才能排除——缺的那条边只剩两个端点，中间 100px 一个点都没有。
  for (let i = 0; i < 4; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % 4];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) return null;
    const ts: number[] = [];
    for (const p of points) {
      if (distToSegment(p, a, b) > RECT_EDGE_TOL) continue;
      ts.push(((p.x - a.x) * ex + (p.y - a.y) * ey) / len);
    }
    ts.sort((p, q) => p - q);
    let maxGap = ts.length ? Math.max(ts[0], len - ts[ts.length - 1]) : len;
    for (let k = 1; k < ts.length; k++) maxGap = Math.max(maxGap, ts[k] - ts[k - 1]);
    if (maxGap > len * 0.35) return null;
  }
  return hull;
}

/** 笔迹的旋转中心候选点：直线 3 个（两端 + 中点），矩形 5 个（中心 + 四角），其它 null。 */
export function strokePivots(points: ReadonlyArray<Pt>): PivotCandidate[] | null {
  if (points.length === 2) {
    const [a, b] = points;
    return [
      { id: 'start', x: a.x, y: a.y },
      { id: 'mid', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      { id: 'end', x: b.x, y: b.y },
    ];
  }
  const corners = rectangleCorners(points);
  if (!corners) return null;
  const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
  const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
  return [
    { id: 'center', x: cx, y: cy },
    ...corners.map((p, i) => ({ id: `corner-${i}`, x: p.x, y: p.y })),
  ];
}

/** 命中候选点：取最近的（短边/小矩形上几个点挨得近，不能永远命中排在前面的那个） */
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
