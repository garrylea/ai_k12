/** 题干图 → 草稿的拖拽（自绘幽灵图 + 目标注册表）。
 *
 *  为什么不用 HTML5 原生拖拽：iPad Safari 触摸不触发 dragstart/drop，而 iPad 横屏是本项目主断点。
 *  指针事件一套代码同时覆盖鼠标、触屏、手写笔。
 *  拖源只管「开始拖」；落点由草稿白板注册的 DropTarget 决定（canvas 矩形即画板坐标系）。 */

export interface DraftDropTarget {
  /** 命中判定用它的 getBoundingClientRect（草稿白板传 canvas） */
  el: HTMLElement;
  onHover: (over: boolean) => void;
  /** pt = 相对 el 的本地坐标（canvas 即 board 坐标） */
  onDrop: (src: string, pt: { x: number; y: number }) => void;
}

const targets = new Set<DraftDropTarget>();

/** 注册落点；返回注销函数（组件卸载时调用） */
export function registerDropTarget(t: DraftDropTarget): () => void {
  targets.add(t);
  return () => { targets.delete(t); };
}

/** 幽灵图宽度（CSS px）：够看清是哪张图，又不至于盖住落点 */
const GHOST_WIDTH = 96;
/** 拖拽结束后吞 click 的时间窗：松手位置若在图片上，避免顺带打开放大浮层 */
const CLICK_SUPPRESS_MS = 300;

let lastDragEndAt = 0;

export function wasJustDragged(): boolean {
  return Date.now() - lastDragEndAt < CLICK_SUPPRESS_MS;
}

interface DragState {
  src: string;
  pointerId: number;
  ghost: HTMLDivElement;
  hovered: DraftDropTarget | null;
}

let state: DragState | null = null;

/** 多个目标重叠时取最后注册的（后挂载的在视觉上层） */
function targetAt(x: number, y: number): DraftDropTarget | null {
  const list = Array.from(targets);
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i].el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return list[i];
  }
  return null;
}

function setHover(next: DraftDropTarget | null): void {
  if (!state || state.hovered === next) return;
  state.hovered?.onHover(false);
  next?.onHover(true);
  state.hovered = next;
}

function moveGhost(x: number, y: number): void {
  if (!state) return;
  state.ghost.style.left = `${x}px`;
  state.ghost.style.top = `${y}px`;
}

function onMove(e: PointerEvent): void {
  if (!state || e.pointerId !== state.pointerId) return;
  moveGhost(e.clientX, e.clientY);
  setHover(targetAt(e.clientX, e.clientY));
}

function onUp(e: PointerEvent): void {
  if (!state || e.pointerId !== state.pointerId) return;
  const target = targetAt(e.clientX, e.clientY);
  if (!target) { cleanup(); return; }
  const r = target.el.getBoundingClientRect();
  const pt = { x: e.clientX - r.left, y: e.clientY - r.top };
  const src = state.src;
  cleanup();
  target.onDrop(src, pt);
}

function onCancel(e: PointerEvent): void {
  if (!state || e.pointerId !== state.pointerId) return;
  cleanup();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') cleanup();
}

function cleanup(): void {
  if (!state) return;
  window.removeEventListener('pointermove', onMove, true);
  window.removeEventListener('pointerup', onUp, true);
  window.removeEventListener('pointercancel', onCancel, true);
  window.removeEventListener('keydown', onKey, true);
  state.hovered?.onHover(false);
  state.ghost.remove();
  state = null;
  lastDragEndAt = Date.now();
}

export function beginImageDrag(opts: {
  src: string;
  pointerId: number;
  clientX: number;
  clientY: number;
}): void {
  cleanup(); // 同时只允许一个拖拽
  const ghost = document.createElement('div');
  ghost.setAttribute('data-draft-drag-ghost', 'true');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.cssText = [
    'position:fixed',
    `left:${opts.clientX}px`,
    `top:${opts.clientY}px`,
    `width:${GHOST_WIDTH}px`,
    'transform:translate(-50%,-50%)',
    'pointer-events:none',
    'z-index:9999',
    'opacity:.75',
    'border-radius:8px',
    'overflow:hidden',
    'background:#fff',
    'box-shadow:0 6px 20px rgba(0,0,0,.25)',
  ].join(';');
  const img = document.createElement('img');
  img.src = opts.src;
  img.alt = '';
  img.draggable = false;
  img.style.cssText = 'display:block;width:100%;height:auto';
  ghost.appendChild(img);
  document.body.appendChild(ghost);

  state = { src: opts.src, pointerId: opts.pointerId, ghost, hovered: null };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
}
