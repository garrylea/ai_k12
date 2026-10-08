// apps/web/src/components/business/HandwritingPad.test.tsx
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import HandwritingPad, { type HandwritingPadHandle } from './HandwritingPad';

beforeEach(() => {
  // jsdom 无 canvas 2d：记录型 stub（模式同 DraftWhiteboard.test.tsx）
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    clearRect() {}, setTransform() {}, beginPath() {}, arc() {}, fill() {},
    moveTo() {}, lineTo() {}, quadraticCurveTo() {}, stroke() {},
    save() {}, restore() {}, fillRect() {},
  }) as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAA');
  Object.defineProperty(Element.prototype, 'setPointerCapture', { value: () => {}, configurable: true });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { value: () => {}, configurable: true });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class { observe() {} disconnect() {} };
});

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

function penLine(canvas: Element, y: number) {
  fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: y });
  fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 200, clientY: y });
  fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'mouse', clientX: 200, clientY: y });
}

it('初始无笔画：onStrokesChange(0)，exportImage 返回 null', () => {
  const ref = createRef<HandwritingPadHandle>();
  const onStrokesChange = vi.fn();
  const { container } = render(<HandwritingPad ref={ref} onStrokesChange={onStrokesChange} />);
  expect(onStrokesChange).toHaveBeenCalledWith(0);
  expect(ref.current!.exportImage()).toBeNull();
  expect(container.querySelector('canvas')).toBeTruthy();
});

it('画一条笔画 → count 1；exportImage 返回 dataURL；清空 → count 0 且 export 为 null', () => {
  const ref = createRef<HandwritingPadHandle>();
  const onStrokesChange = vi.fn();
  const { container } = render(<HandwritingPad ref={ref} onStrokesChange={onStrokesChange} />);
  penLine(container.querySelector('canvas')!, 50);
  expect(onStrokesChange).toHaveBeenLastCalledWith(1);
  expect(ref.current!.exportImage()).toBe('data:image/png;base64,AAA');
  fireEvent.click(container.querySelector('button[title="清空"]')!);
  expect(onStrokesChange).toHaveBeenLastCalledWith(0);
  expect(ref.current!.exportImage()).toBeNull();
});

it('橡皮：擦过的笔画整条消失', () => {
  const ref = createRef<HandwritingPadHandle>();
  const onStrokesChange = vi.fn();
  const { container } = render(<HandwritingPad ref={ref} onStrokesChange={onStrokesChange} />);
  const canvas = container.querySelector('canvas')!;
  penLine(canvas, 50);
  fireEvent.click(container.querySelector('button[title="橡皮"]')!);
  // 划过笔画中段 (150,50)，容差 size(3)+8 → 命中整条擦除
  fireEvent.pointerDown(canvas, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 150, clientY: 50 });
  fireEvent.pointerUp(canvas, { pointerId: 2, pointerType: 'mouse', clientX: 150, clientY: 50 });
  expect(onStrokesChange).toHaveBeenLastCalledWith(0);
});
