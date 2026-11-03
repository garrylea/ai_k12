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

  it('手势中选区被清空：主动结束手势（否则父级撤销门闩永远卡死）', () => {
    const onGesture = vi.fn();
    const { container, rerender } = render(
      <DraftImageLayer images={[IMG]} onImagesChange={() => {}} selectedIds={new Set(['i1'])} handlesEnabled onGestureChange={onGesture} />,
    );
    fireEvent.pointerDown(container.querySelector('[data-corner="se"]')!, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(onGesture).toHaveBeenLastCalledWith(true);

    // 控制点随选区消失：pointerup / lostpointercapture 都到不了已卸载的节点
    rerender(
      <DraftImageLayer images={[IMG]} onImagesChange={() => {}} selectedIds={new Set()} handlesEnabled={false} onGestureChange={onGesture} />,
    );
    expect(onGesture).toHaveBeenLastCalledWith(false);
  });

  it('手势中整层卸载：主动结束手势', () => {
    const onGesture = vi.fn();
    const { container, unmount } = render(
      <DraftImageLayer images={[IMG]} onImagesChange={() => {}} selectedIds={new Set(['i1'])} handlesEnabled onGestureChange={onGesture} />,
    );
    fireEvent.pointerDown(container.querySelector('[data-corner="se"]')!, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(onGesture).toHaveBeenLastCalledWith(true);

    unmount();
    expect(onGesture).toHaveBeenLastCalledWith(false);
  });
});
