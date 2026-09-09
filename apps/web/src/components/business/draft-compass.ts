/** 圆规工具：纯几何/状态辅助（无 React、无 DOM），DraftWhiteboard 持状态机并调用这些函数。
 *  设计：docs/superpowers/plans/2026-09-09-draft-shape-tools.md §3
 *  图形落笔即采样为点列（DraftWhiteboard 包装成 Stroke），复用渲染/橡皮/持久化管道。 */

import type { DraftPoint } from './draft-store';

/** 最小半径（px）：placing 拖出半径或 resizing 调整的下限 */
export const MIN_R = 16;
/** 默认半径（px）：点按放置（未拖出半径）时沿用记忆半径的初始值 */
export const DEFAULT_R = 80;
/** 半径手柄命中半径（px）：按下点距手柄不超过该值才算「拖手柄」 */
export const HANDLE_HIT_R = 14;
/** 点按位移阈值（px）：按下到抬手位移不超过该值视为「点按」（搬圆心），否则视为拖动 */
export const TAP_SLOP = 6;
/** 最小扫过角（rad）：抬手时扫过角不足该值则丢弃（防误触产生零碎弧） */
export const MIN_SWEEP = (2 * Math.PI) / 180;

export interface CompassPlaced {
  cx: number;
  cy: number;
  r: number;
}

/** 圆规状态机：idle(未放置) → ready(圆心+半径已定)；placing/resizing/drawing 为指针手势过渡态 */
export type CompassState =
  | { phase: 'idle' }
  | ({ phase: 'ready' } & CompassPlaced)
  | ({ phase: 'placing' } & CompassPlaced)                             // 按下即定圆心，拖动调半径
  | ({ phase: 'resizing' } & CompassPlaced)                            // 拖住半径手柄调半径
  | ({ phase: 'drawing'; a0: number; sweep: number } & CompassPlaced); // 画弧进行中

/** 角度归一到 (-π, π]（最短角差方向累积用） */
export function normalizeAngle(a: number): number {
  const t = ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return t === 0 ? -Math.PI : t - Math.PI;
}

/** 指针相对圆心的方位角（x 右 y 下的屏幕坐标系，atan2 直接适用） */
export function angleAt(cx: number, cy: number, x: number, y: number): number {
  return Math.atan2(y - cy, x - cx);
}

/** 半径手柄圆心位置：锚在参考圆上、角度取 handleAngle（最近一次交互落角） */
export function handlePos(c: CompassPlaced, handleAngle: number): { x: number; y: number } {
  return { x: c.cx + c.r * Math.cos(handleAngle), y: c.cy + c.r * Math.sin(handleAngle) };
}

/** 按下点是否命中半径手柄（命中区内优先「调半径」而非「画弧」） */
export function hitHandle(c: CompassPlaced, handleAngle: number, x: number, y: number): boolean {
  const h = handlePos(c, handleAngle);
  return Math.hypot(h.x - x, h.y - y) <= HANDLE_HIT_R;
}

/**
 * 弧采样：从 a0 沿 sweep 方向到 a0+sweep，步长角按弦长 ~3px 自适应（整圆最少 64 点封底），
 * 两端点闭合。返回点列，由调用方包装成 Stroke（线宽等白板层决定）。
 */
export function sampleArc(c: CompassPlaced, a0: number, sweep: number): DraftPoint[] {
  const abs = Math.abs(sweep);
  if (abs < 1e-9) {
    return [{ x: c.cx + c.r * Math.cos(a0), y: c.cy + c.r * Math.sin(a0), pressure: 0.5 }];
  }
  const step = Math.max((2 * Math.PI) / 64, 2 * Math.asin(Math.min(0.75, c.r / 2) / Math.max(c.r, 1)));
  const n = Math.max(2, Math.ceil(abs / step) + 1);
  const points: DraftPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (sweep * i) / (n - 1);
    points.push({ x: c.cx + c.r * Math.cos(a), y: c.cy + c.r * Math.sin(a), pressure: 0.5 });
  }
  return points;
}

/** 整圆采样（最少 64 点保证小半径也圆滑，末点闭合到起点） */
export function sampleCircle(c: CompassPlaced): DraftPoint[] {
  const step = Math.max((2 * Math.PI) / 64, 2 * Math.asin(Math.min(0.75, c.r / 2) / Math.max(c.r, 1)));
  const n = Math.max(64, Math.ceil((2 * Math.PI) / step));
  const points: DraftPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    points.push({ x: c.cx + c.r * Math.cos(a), y: c.cy + c.r * Math.sin(a), pressure: 0.5 });
  }
  return points;
}
