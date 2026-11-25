/** 选区旋转旋钮的位置与命中（纯几何，无 DOM/React，便于单测）。
 *
 *  为什么单独成模块：旋钮位置有两处消费者（canvas 重绘与起手命中判定），必须同一口径；
 *  平移到 `DraftWhiteboard.tsx` 里导出会破坏 fast refresh（该文件只应导出组件），
 *  本仓同类几何也都是独立模块（`draft-shape-pivots` / `draft-compass`）。
 */

export interface RotateHandle {
  x: number;
  y: number;
  /** 连线接在包围盒的哪条边（上方手柄接 y0，下方手柄接 y1） */
  edgeY: number;
  below: boolean;
}

/** 旋钮本体半径（CSS px） */
export const ROTATE_HANDLE_R = 6;
/** 旋钮离选区包围盒的距离（CSS px） */
const ROTATE_HANDLE_GAP = 26;
/** 命中半径 20px：iPad 手指够得着（本体只有 12px 直径） */
const ROTATE_HANDLE_HIT = 20;
/** 顶部让位：画板顶部有提示条，y0 太靠上时旋钮改放下方 */
const TOP_INSET = 48;

/** 旋钮落在画板可视区内：大图形/绕端点转过之后，上方放不下会改放下方，
 *  下方也可能超出画板底边 —— 那样旋钮就抓不到了（学生表现为「图形转不了了」）；
 *  图形有一半在画板外时 x 同理夹回来。bounds 未知（首帧/无布局）时不夹取。 */
export function rotateHandleFor(
  b: { x0: number; y0: number; x1: number; y1: number },
  bounds: { w: number; h: number },
): RotateHandle {
  const w = bounds.w > 0 ? bounds.w : Number.POSITIVE_INFINITY;
  const h = bounds.h > 0 ? bounds.h : Number.POSITIVE_INFINITY;
  const pad = ROTATE_HANDLE_R + 4;
  const x = Math.min(Math.max((b.x0 + b.x1) / 2, pad), Math.max(pad, w - pad));
  return b.y0 >= TOP_INSET
    ? { x, y: Math.max(b.y0 - ROTATE_HANDLE_GAP, pad), edgeY: b.y0 - 4, below: false }
    : { x, y: Math.min(b.y1 + ROTATE_HANDLE_GAP, Math.max(pad, h - pad)), edgeY: b.y1 + 4, below: true };
}

export function hitRotateHandle(
  b: { x0: number; y0: number; x1: number; y1: number },
  x: number,
  y: number,
  bounds: { w: number; h: number },
): boolean {
  const h = rotateHandleFor(b, bounds);
  return Math.hypot(h.x - x, h.y - y) <= ROTATE_HANDLE_HIT;
}
