/** 草稿白板内存缓存：模块级 Map，随题（key）隔离。
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
}
