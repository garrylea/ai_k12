import { describe, it, expect } from 'vitest';
import { convexHull, rectangleCorners, strokePivots, nearestPivot } from './draft-shape-pivots';

type Pt = { x: number; y: number };

/** 与白板矩形工具同款采样：沿四边按 ~3px 步长加密 + 末点闭合回起点 */
function sampleRect(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const v: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const pts: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const a = v[i];
    const b = v[(i + 1) % 4];
    const m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3));
    for (let j = 0; j < m; j++) {
      pts.push({ x: a[0] + (b[0] - a[0]) * (j / m), y: a[1] + (b[1] - a[1]) * (j / m) });
    }
  }
  pts.push({ x: v[0][0], y: v[0][1] });
  return pts;
}

function rotate(pts: Pt[], cx: number, cy: number, deg: number): Pt[] {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return pts.map((p) => ({
    x: cx + (p.x - cx) * c - (p.y - cy) * s,
    y: cy + (p.x - cx) * s + (p.y - cy) * c,
  }));
}

const sortPts = (pts: ReadonlyArray<Pt>) =>
  pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).sort();

describe('convexHull', () => {
  it('矩形采样点的凸包正好是四个角（共线点被剔除）', () => {
    const hull = convexHull(sampleRect(100, 100, 200, 160));
    expect(hull).toHaveLength(4);
  });

  it('椭圆采样点凸包顶点很多，不是四角', () => {
    const pts: Pt[] = [];
    for (let i = 0; i < 64; i++) {
      const a = (2 * Math.PI * i) / 64;
      pts.push({ x: 150 + 80 * Math.cos(a), y: 130 + 40 * Math.sin(a) });
    }
    expect(convexHull(pts).length).toBeGreaterThan(4);
  });
});

describe('rectangleCorners', () => {
  it('轴对齐矩形：四角坐标正确', () => {
    const corners = rectangleCorners(sampleRect(100, 100, 200, 160));
    expect(corners).not.toBeNull();
    expect(sortPts(corners!)).toEqual(sortPts([
      { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 160 }, { x: 100, y: 160 },
    ]));
  });

  it('已旋转 30° 的矩形仍能认出，角点跟着转', () => {
    const pts = rotate(sampleRect(100, 100, 200, 160), 150, 130, 30);
    const corners = rectangleCorners(pts);
    expect(corners).not.toBeNull();
    const expected = rotate(
      [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 160 }, { x: 100, y: 160 }],
      150, 130, 30,
    );
    expect(sortPts(corners!)).toEqual(sortPts(expected));
  });

  it('平行四边形（四角不是直角）不算矩形', () => {
    const v: Pt[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 130, y: 60 }, { x: 30, y: 60 }];
    const pts: Pt[] = [];
    for (let i = 0; i < 4; i++) {
      const a = v[i];
      const b = v[(i + 1) % 4];
      const m = 40;
      for (let j = 0; j < m; j++) pts.push({ x: a.x + (b.x - a.x) * (j / m), y: a.y + (b.y - a.y) * (j / m) });
    }
    expect(rectangleCorners(pts)).toBeNull();
  });

  it('开口的 U 形不算矩形（缺一条边）', () => {
    const all = sampleRect(100, 100, 200, 160);
    // 只留左、下、右三条边（去掉 y≈100 的上边）
    const u = all.filter((p) => p.y > 101);
    expect(rectangleCorners(u)).toBeNull();
  });

  it('三角形不算矩形', () => {
    const v: Pt[] = [{ x: 100, y: 100 }, { x: 220, y: 100 }, { x: 100, y: 200 }];
    const pts: Pt[] = [];
    for (let i = 0; i < 3; i++) {
      const a = v[i];
      const b = v[(i + 1) % 3];
      const m = 40;
      for (let j = 0; j < m; j++) pts.push({ x: a.x + (b.x - a.x) * (j / m), y: a.y + (b.y - a.y) * (j / m) });
    }
    expect(rectangleCorners(pts)).toBeNull();
  });

  it('手写乱涂不算矩形', () => {
    const pts: Pt[] = [];
    for (let i = 0; i < 200; i++) {
      pts.push({ x: 100 + i * 0.5, y: 130 + Math.sin(i / 3) * 40 + Math.cos(i / 7) * 12 });
    }
    expect(rectangleCorners(pts)).toBeNull();
  });
});

describe('strokePivots', () => {
  it('直线：两端点 + 中点', () => {
    expect(strokePivots([{ x: 100, y: 100 }, { x: 200, y: 100 }])).toEqual([
      { id: 'start', x: 100, y: 100 },
      { id: 'mid', x: 150, y: 100 },
      { id: 'end', x: 200, y: 100 },
    ]);
  });

  it('矩形：中心 + 四角，共 5 个候选', () => {
    const pivots = strokePivots(sampleRect(100, 100, 200, 160));
    expect(pivots).not.toBeNull();
    expect(pivots!).toHaveLength(5);
    const center = pivots!.find((p) => p.id === 'center')!;
    expect(center.x).toBeCloseTo(150, 6);
    expect(center.y).toBeCloseTo(130, 6);
    expect(sortPts(pivots!.filter((p) => p.id !== 'center'))).toEqual(sortPts([
      { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 160 }, { x: 100, y: 160 },
    ]));
  });

  it('其它图形返回 null（仍绕包围盒中心）', () => {
    expect(strokePivots([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }])).toBeNull();
  });
});

describe('nearestPivot', () => {
  const pivots = [
    { id: 'a', x: 100, y: 100 },
    { id: 'b', x: 140, y: 100 },
  ];

  it('取最近且在命中半径内', () => {
    expect(nearestPivot(pivots, 106, 100, 16)?.id).toBe('a');
    expect(nearestPivot(pivots, 134, 100, 16)?.id).toBe('b');
  });

  it('超出半径返回 null', () => {
    expect(nearestPivot(pivots, 120, 100, 16)).toBeNull();
  });
});
