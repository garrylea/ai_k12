import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { beginImageDrag, registerDropTarget, wasJustDragged } from './draft-image-drag';

/** jsdom 所有 getBoundingClientRect 都是 0，这里给目标一个真矩形 */
function makeTarget(rect: { left: number; top: number; width: number; height: number }) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    left: rect.left, top: rect.top,
    right: rect.left + rect.width, bottom: rect.top + rect.height,
    width: rect.width, height: rect.height,
    x: rect.left, y: rect.top, toJSON: () => ({}),
  }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('draft-image-drag', () => {
  it('进入草稿区回调 hover，松手按本地坐标回调 drop 并清理幽灵图', () => {
    const el = makeTarget({ left: 100, top: 50, width: 200, height: 200 });
    const onHover = vi.fn();
    const onDrop = vi.fn();
    const off = registerDropTarget({ el, onHover, onDrop });

    beginImageDrag({ src: '/assets/q.png', pointerId: 1, clientX: 120, clientY: 60 });
    expect(document.querySelector('[data-draft-drag-ghost]')).toBeTruthy();

    fireEvent.pointerMove(window, { pointerId: 1, clientX: 150, clientY: 100 });
    expect(onHover).toHaveBeenLastCalledWith(true);

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 150, clientY: 100 });
    expect(onDrop).toHaveBeenCalledWith('/assets/q.png', { x: 50, y: 50 });
    expect(onHover).toHaveBeenLastCalledWith(false);
    expect(document.querySelector('[data-draft-drag-ghost]')).toBeNull();
    off();
  });

  it('松手在草稿区外：不插入', () => {
    const el = makeTarget({ left: 100, top: 50, width: 100, height: 100 });
    const onDrop = vi.fn();
    const off = registerDropTarget({ el, onHover: () => {}, onDrop });
    beginImageDrag({ src: '/assets/q.png', pointerId: 1, clientX: 500, clientY: 500 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 500, clientY: 500 });
    expect(onDrop).not.toHaveBeenCalled();
    off();
  });

  it('pointercancel / Escape 取消：不插入，幽灵图清理', () => {
    const el = makeTarget({ left: 0, top: 0, width: 300, height: 300 });
    const onDrop = vi.fn();
    const off = registerDropTarget({ el, onHover: () => {}, onDrop });

    beginImageDrag({ src: '/assets/q.png', pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerCancel(window, { pointerId: 1, clientX: 50, clientY: 50 });
    expect(onDrop).not.toHaveBeenCalled();
    expect(document.querySelector('[data-draft-drag-ghost]')).toBeNull();

    beginImageDrag({ src: '/assets/q.png', pointerId: 2, clientX: 50, clientY: 50 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDrop).not.toHaveBeenCalled();
    expect(document.querySelector('[data-draft-drag-ghost]')).toBeNull();
    off();
  });

  it('拖拽结束后 300ms 内 wasJustDragged 为真', () => {
    beginImageDrag({ src: '/assets/q.png', pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerCancel(window, { pointerId: 1, clientX: 0, clientY: 0 });
    expect(wasJustDragged()).toBe(true);
  });
});
