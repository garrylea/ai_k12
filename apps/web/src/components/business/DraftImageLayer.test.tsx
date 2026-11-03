import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { DraftImageLayer } from './DraftImageLayer';

const IMG = { id: 'i1', src: '/assets/x.png', x: 10, y: 20, w: 100, h: 60 };

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'setPointerCapture', { value: () => {}, configurable: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DraftImageLayer', () => {
  it('用 src 渲染贴图', () => {
    const { container } = render(
      <DraftImageLayer images={[IMG]} onImagesChange={() => {}} selectedIds={new Set()} handlesEnabled={false} />,
    );
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/assets/x.png');
  });

  it('删除贴图后回调 onCommit', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { container } = render(
      <DraftImageLayer images={[IMG]} onImagesChange={onChange} selectedIds={new Set(['i1'])} handlesEnabled onCommit={onCommit} />,
    );
    fireEvent.click(container.querySelector('button[aria-label="删除图片"]')!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('缩放手势结束后回调 onCommit（未拖动也只在结束后调一次）', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <DraftImageLayer images={[IMG]} onImagesChange={() => {}} selectedIds={new Set(['i1'])} handlesEnabled onCommit={onCommit} />,
    );
    const handle = container.querySelector('[data-corner="se"]')!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('缩放手势起止回调 onGestureChange（父级据此把手势算进撤销守卫）', () => {
    const onGesture = vi.fn();
    const { container } = render(
      <DraftImageLayer
        images={[IMG]}
        onImagesChange={() => {}}
        selectedIds={new Set(['i1'])}
        handlesEnabled
        onGestureChange={onGesture}
      />,
    );
    const handle = container.querySelector('[data-corner="se"]')!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(onGesture).toHaveBeenCalledWith(true);
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(onGesture).toHaveBeenCalledWith(false);
    expect(onGesture.mock.calls).toEqual([[true], [false]]);
  });
});
