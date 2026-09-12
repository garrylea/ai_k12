/** 草稿白板内存缓存：模块级 Map，随题（key）隔离。笔迹与贴图两个并行 Map，clearDraft 同时清两者。
 *  生命周期约定（PRD §7.12）：切 tab / 关开弹窗保留；提交后由父组件调 clearDraft；切题天然隔离。 */

export interface DraftPoint {
  x: number;
  y: number;
  pressure: number;
}

export interface Stroke {
  points: DraftPoint[];
  /** 基准笔画宽（CSS px），压感 0.5x~1.5x 映射 */
  size: number;
  /** 圆心标记（仅正圆：圆规整圆 / Shift 正圆）：轮廓之上补一个实心圆点，随笔迹一起平移/擦除。
   *  不参与橡皮与选中的命中判定（命中仍是「整条擦除」语义）。 */
  center?: DraftPoint;
}

const store = new Map<string, Stroke[]>();

export function getDraft(key: string): Stroke[] {
  return store.get(key) ?? [];
}

export function setDraft(key: string, strokes: Stroke[]): void {
  store.set(key, strokes);
}

export function clearDraft(key: string): void {
  store.delete(key);
  imageStore.delete(key);
}

/** 草稿贴图：坐标/尺寸相对 board（与笔迹同坐标系；scroll-y 模式 y 可超一屏） */
export interface DraftImage {
  id: string;      // 前端唯一标识，见 draft-image-utils.newImageId()
  dataUrl: string; // 压缩后的 data URL（最大边 ≤1600，见 draft-image-utils）
  x: number;
  y: number;
  w: number; // 显示宽（CSS px）
  h: number; // 显示高（CSS px）
}

const imageStore = new Map<string, DraftImage[]>();

export function getDraftImages(key: string): DraftImage[] {
  return imageStore.get(key) ?? [];
}

export function setDraftImages(key: string, images: DraftImage[]): void {
  imageStore.set(key, images);
}
