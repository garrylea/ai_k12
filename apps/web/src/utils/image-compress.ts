// 作答区贴图压缩：最长边 ≤1600 转 JPEG，供 POST /api/files/upload。
// 为什么不复用 draft-image-utils：那边产出 data URL（草稿画布内存贴图），这里要可上传的 File。
// 为什么铺白底：canvas 默认透明，PNG 转 JPEG 后透明区会变黑。

export const MAX_IMAGE_EDGE = 1600;
/** 单张上限（压缩前），与辅线答疑输入栏一致 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const JPEG_QUALITY = 0.85;
/** 小于该体积且未超尺寸就不重编码，省一次画布往返（截图类图片通常已足够小） */
const PASS_THROUGH_BYTES = 1024 * 1024;

/** 等比缩放到最长边 ≤ maxEdge，不放大。纯函数，单测覆盖。 */
export function scaleSize(w: number, h: number, maxEdge = MAX_IMAGE_EDGE): { w: number; h: number } {
  const edge = Math.max(w, h);
  if (edge <= maxEdge) return { w, h };
  const k = maxEdge / edge;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** File → HTMLImageElement（objectURL 在解码完成后释放，避免泄漏） */
async function decode(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function compressImageFile(file: File): Promise<File> {
  const img = await decode(file);
  if (Math.max(img.naturalWidth, img.naturalHeight) <= MAX_IMAGE_EDGE && file.size <= PASS_THROUGH_BYTES) {
    return file;
  }
  const { w, h } = scaleSize(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file; // 无 canvas 的极端环境：宁可传原图，也不能把学生的图弄丢
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) return file;
  const name = `${file.name.replace(/\.[^./\\]+$/, '')}.jpg`;
  return new File([blob], name, { type: 'image/jpeg' });
}
