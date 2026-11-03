/** 草稿历史：按题（key）保存「操作后的完整快照」列表 + 游标，支持撤销/重做。
 *
 *  为什么用快照而不是逆操作：移动、旋转、橡皮整段擦除、批量删除的逆运算分支太多，
 *  漏一个就是静默数据损坏；快照只要保证「旧对象不被改」即可。
 *  为什么只复制数组：Stroke/DraftImage 元素对象在历史里共享（结构共享），
 *  50 步的额外内存只是数组槽位。前提是**已进历史的元素对象只读**——
 *  唯一会原地改坐标的「选中移动」「旋转」必须在起手时先克隆（见 DraftWhiteboard.startRotate / selectDown）。 */

import type { Stroke, DraftImage } from './draft-store';

export interface DraftState {
  strokes: Stroke[];
  images: DraftImage[];
}

/** 1 个初始态 + 最多 50 步撤销 */
const MAX_STATES = 51;

interface Entry {
  states: DraftState[];
  index: number;
}

const store = new Map<string, Entry>();

/** 数组逐项引用比较：元素对象只读且共享，所以引用全同 = 内容没变 */
function sameArray<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function getHistory(key: string): { states: DraftState[]; index: number } | undefined {
  return store.get(key);
}

/** 挂载时登记初始态；已有历史则不动（关面板再开要保留撤销栈） */
export function initHistory(key: string, initial: DraftState): void {
  if (store.has(key)) return;
  store.set(key, { states: [initial], index: 0 });
}

/** 记录一次操作后的状态；内容与当前态相同则不入栈，返回是否真的入栈 */
export function pushState(key: string, state: DraftState): boolean {
  const entry = store.get(key);
  if (!entry) {
    store.set(key, { states: [state], index: 0 });
    return true;
  }
  const current = entry.states[entry.index];
  if (sameArray(current.strokes, state.strokes) && sameArray(current.images, state.images)) return false;

  entry.states.length = entry.index + 1; // 撤销后做新操作：重做栈作废
  entry.states.push(state);
  entry.index = entry.states.length - 1;
  if (entry.states.length > MAX_STATES) {
    entry.states.shift();  // 丢最旧，不影响当前内容
    entry.index -= 1;
  }
  return true;
}

export function undo(key: string): DraftState | null {
  const entry = store.get(key);
  if (!entry || entry.index === 0) return null;
  entry.index -= 1;
  return entry.states[entry.index];
}

export function redo(key: string): DraftState | null {
  const entry = store.get(key);
  if (!entry || entry.index >= entry.states.length - 1) return null;
  entry.index += 1;
  return entry.states[entry.index];
}

export function canUndo(key: string): boolean {
  const entry = store.get(key);
  return !!entry && entry.index > 0;
}

export function canRedo(key: string): boolean {
  const entry = store.get(key);
  return !!entry && entry.index < entry.states.length - 1;
}

export function clearHistory(key: string): void {
  store.delete(key);
}
