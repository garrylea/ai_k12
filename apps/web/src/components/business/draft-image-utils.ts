// apps/web/src/components/business/draft-image-utils.ts
// 草稿贴图工具：File → 压缩 data URL → DraftImage（初始尺寸/落点）。
// 内存保护：data URL 全程在内存，最大边 >1600px 先等比缩再转，避免大图撑爆页面。
import type { DraftImage } from './draft-store';

/** 压缩上限（px）：图片最大边超过该值先等比缩到该值 */
const MAX_EDGE = 1600;
/** 贴图初始宽 = board 宽 × 该系数（等比；原图更小则按原图） */
const INIT_WIDTH_FACTOR = 0.6;

/** 事件目标是输入框/可编辑元素时返回 true（粘贴/删除键此时必须放行，不拦截） */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

/** 图片文件 → 压缩 data URL + 尺寸。FileReader 读出后经 Image 解码取自然尺寸，超限走离屏 canvas。 */
async function loadImage(file: File): Promise<{ dataUrl: string; w: number; h: number }> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('image decode failed'));
    el.src = rawDataUrl;
  });
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (Math.max(w, h) <= MAX_EDGE) return { dataUrl: rawDataUrl, w, h };
  const scale = MAX_EDGE / Math.max(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const type = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ? file.type : 'image/png';
  return { dataUrl: canvas.toDataURL(type), w: canvas.width, h: canvas.height };
}

/** 生成贴图 id。crypto.randomUUID 仅安全上下文（HTTPS / localhost）可用，
 *  经局域网 IP 走 HTTP 访问时为 undefined（Mac 之间联调常见），故降级到随机串。
 *  id 只用于前端身份识别（React key / 选中集合），无需真 UUID。 */
function newImageId(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 图片文件 → 待插入 DraftImage：初始宽 board 宽 × 0.6（原图更小按原图），等比，
 *  落在可视区域中央（scroll-y 模式 viewport.top = wrap.scrollTop；负坐标夹到 0）。 */
export async function fileToDraftImage(
  file: File,
  boardW: number,
  viewport: { left: number; top: number; width: number; height: number },
): Promise<DraftImage> {
  const { dataUrl, w: nw, h: nh } = await loadImage(file);
  const w = Math.min(Math.round(boardW * INIT_WIDTH_FACTOR), nw);
  const h = Math.round((w / nw) * nh);
  const x = Math.max(0, Math.round(viewport.left + (viewport.width - w) / 2));
  const y = Math.max(0, Math.round(viewport.top + (viewport.height - h) / 2));
  return { id: newImageId(), dataUrl, x, y, w, h };
}
