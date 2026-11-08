/** 草稿渲染的纯函数层：白板实时重绘与「导出快照给判题」共用同一套笔迹绘制，
 *  避免两处渲染口径漂移（学生看到的草稿与判题看到的图必须是同一张）。 */

import type { Stroke, DraftImage } from './draft-store';

/** 圆心标记点半径（CSS px）：与圆规参考层的圆心锚点同尺寸，保持「画的圆心」和「预览的圆心」观感一致 */
const CENTER_DOT_R = 3;

/**
 * 单条笔画平滑渲染（取代 perfect-freehand 填充轮廓画法）：
 * - 统一细线宽 + 圆头圆角（lineCap/lineJoin round），细且均匀；
 * - 用「顶点为控制点、相邻顶点中点为起止」的二次贝塞尔段串成连续曲线（C1 连续），
 *   曲线天然穿过相邻点中点 = 渲染期低通（抑制手抖高频抖动）；
 * - 输入侧不做 EWMA 前向平滑（之前 streamline 让笔尖滞后），最新采样点直接落笔 →
 *   渲染零跟手延迟。stroke.size 通常为 INK_WIDTH（「点」工具为 DOT_SIZE，单点笔迹取它当直径）。
 * - stroke.center 存在时（正圆）在轮廓之上补一个实心圆心点。
 */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
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

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[]): void {
  for (const s of strokes) drawStroke(ctx, s);
}

/** 把图片解码成可 drawImage 的 Image 元素；失败（坏图/跨域拿不到）解析为 null，由调用方跳过 */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => resolve(null);
    i.src = src;
  });
}

/**
 * 导出草稿快照（判题用图）：白底 JPEG。
 * - 笔迹与贴图都为空 → null（没有可看的草稿，调用方据此决定不附图）；
 * - 长边超过 maxEdge（默认 1600）等比缩小，避免大画板导出几 MB 的图；
 * - 先铺白底再画：夜间主题下笔迹可能是浅色，透明底会让浅色笔迹在白纸/深底上看不见。
 */
export async function renderDraftSnapshot(opts: {
  strokes: Stroke[]; images: DraftImage[]; width: number; height: number;
  maxEdge?: number; quality?: number;
}): Promise<string | null> {
  if (opts.strokes.length === 0 && opts.images.length === 0) return null;
  const maxEdge = opts.maxEdge ?? 1600;
  const scale = Math.min(1, maxEdge / Math.max(opts.width, opts.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(opts.width * scale));
  canvas.height = Math.max(1, Math.round(opts.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  drawStrokes(ctx, opts.strokes);
  for (const img of opts.images) {
    const el = await loadImage(img.src);
    if (el) ctx.drawImage(el, img.x, img.y, img.w, img.h);
  }
  return canvas.toDataURL('image/jpeg', opts.quality ?? 0.85);
}
