// apps/web/src/components/business/HandwritingPad.test.tsx
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, fireEvent, act, screen } from '@testing-library/react';
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

it('画一条笔画 → count 1；exportImage 返回 dataURL；两段式清空 → count 0 且 export 为 null', () => {
  const ref = createRef<HandwritingPadHandle>();
  const onStrokesChange = vi.fn();
  const { container } = render(<HandwritingPad ref={ref} onStrokesChange={onStrokesChange} />);
  penLine(container.querySelector('canvas')!, 50);
  expect(onStrokesChange).toHaveBeenLastCalledWith(1);
  expect(ref.current!.exportImage()).toBe('data:image/png;base64,AAA');
  // 清空需二次确认：第一次点击只进入「确认清空」态，笔迹保留
  fireEvent.click(container.querySelector('button[title="清空"]')!);
  expect(onStrokesChange).toHaveBeenLastCalledWith(1);
  fireEvent.click(container.querySelector('button[title="再点一次确认清空全部笔迹"]')!);
  expect(onStrokesChange).toHaveBeenLastCalledWith(0);
  expect(ref.current!.exportImage()).toBeNull();
});

it('清空待确认态 3s 超时自动还原，笔迹保留', () => {
  vi.useFakeTimers();
  try {
    const onStrokesChange = vi.fn();
    const { container } = render(<HandwritingPad onStrokesChange={onStrokesChange} />);
    penLine(container.querySelector('canvas')!, 50);
    fireEvent.click(container.querySelector('button[title="清空"]')!);
    // 超时后按钮还原为「清空」，笔迹未动
    act(() => { vi.advanceTimersByTime(3000); });
    expect(container.querySelector('button[title="清空"]')).toBeTruthy();
    expect(onStrokesChange).toHaveBeenLastCalledWith(1);
  } finally {
    vi.useRealTimers();
  }
});

it('快捷键：按 E 切橡皮（可擦除笔画），按 P 切回笔（可继续作画）', () => {
  const onStrokesChange = vi.fn();
  const { container } = render(<HandwritingPad onStrokesChange={onStrokesChange} />);
  const canvas = container.querySelector('canvas')!;
  penLine(canvas, 50);
  // 按 E → 橡皮：划过笔画中段即整条擦除
  fireEvent.keyDown(window, { key: 'e' });
  fireEvent.pointerDown(canvas, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 150, clientY: 50 });
  fireEvent.pointerUp(canvas, { pointerId: 2, pointerType: 'mouse', clientX: 150, clientY: 50 });
  expect(onStrokesChange).toHaveBeenLastCalledWith(0);
  // 按 P（大写同样生效）→ 笔：可再画一条
  fireEvent.keyDown(window, { key: 'P' });
  penLine(canvas, 100);
  expect(onStrokesChange).toHaveBeenLastCalledWith(1);
});

it('快捷键不干扰输入：焦点在 input 内按 p/e 不切工具', () => {
  const onStrokesChange = vi.fn();
  const { container } = render(
    <div>
      <input data-testid="field" />
      <HandwritingPad onStrokesChange={onStrokesChange} />
    </div>,
  );
  const canvas = container.querySelector('canvas')!;
  penLine(canvas, 50);
  const input = screen.getByTestId('field');
  input.focus();
  fireEvent.keyDown(input, { key: 'e' });
  // 仍是笔：同位置按下落下的是新笔画（总数 2），而非擦除后重画（总数 1）
  fireEvent.pointerDown(canvas, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 150, clientY: 50 });
  fireEvent.pointerUp(canvas, { pointerId: 2, pointerType: 'mouse', clientX: 150, clientY: 50 });
  expect(onStrokesChange).toHaveBeenLastCalledWith(2);
});

it('撤销/重做：画两笔 → 撤销回一笔 → 重做回两笔；新笔画作废重做栈', () => {
  const onStrokesChange = vi.fn();
  const { container } = render(<HandwritingPad onStrokesChange={onStrokesChange} />);
  const canvas = container.querySelector('canvas')!;
  const undoBtn = container.querySelector('button[title="撤销（Ctrl+Z）"]') as HTMLButtonElement;
  const redoBtn = container.querySelector('button[title="重做（Ctrl+Shift+Z）"]') as HTMLButtonElement;
  // 初始空板：两个按钮都禁用
  expect(undoBtn.disabled).toBe(true);
  expect(redoBtn.disabled).toBe(true);
  penLine(canvas, 50);
  penLine(canvas, 100);
  expect(onStrokesChange).toHaveBeenLastCalledWith(2);
  expect(undoBtn.disabled).toBe(false);
  fireEvent.click(undoBtn);
  expect(onStrokesChange).toHaveBeenLastCalledWith(1);
  expect(redoBtn.disabled).toBe(false);
  fireEvent.click(redoBtn);
  expect(onStrokesChange).toHaveBeenLastCalledWith(2);
  // 撤销后画新笔画：重做栈清空（旧分支不可再回去）
  fireEvent.click(undoBtn);
  penLine(canvas, 150);
  expect(onStrokesChange).toHaveBeenLastCalledWith(2);
  expect(redoBtn.disabled).toBe(true);
});

it('撤销清空：清空后撤销可恢复全部笔迹', () => {
  const ref = createRef<HandwritingPadHandle>();
  const onStrokesChange = vi.fn();
  const { container } = render(<HandwritingPad ref={ref} onStrokesChange={onStrokesChange} />);
  const canvas = container.querySelector('canvas')!;
  penLine(canvas, 50);
  penLine(canvas, 100);
  fireEvent.click(container.querySelector('button[title="清空"]')!);
  fireEvent.click(container.querySelector('button[title="再点一次确认清空全部笔迹"]')!);
  expect(onStrokesChange).toHaveBeenLastCalledWith(0);
  fireEvent.click(container.querySelector('button[title="撤销（Ctrl+Z）"]')!);
  expect(onStrokesChange).toHaveBeenLastCalledWith(2);
  expect(ref.current!.exportImage()).toBe('data:image/png;base64,AAA');
});

it('橡皮拖拽擦掉两笔只记一步：撤销一次即全部恢复', () => {
  const onStrokesChange = vi.fn();
  const { container } = render(<HandwritingPad onStrokesChange={onStrokesChange} />);
  const canvas = container.querySelector('canvas')!;
  penLine(canvas, 50);
  penLine(canvas, 52);
  fireEvent.click(container.querySelector('button[title="橡皮（快捷键 E）"]')!);
  // 同一次按下-抬起里划过两笔（(150,50) 容差 10 覆盖 y=52）
  fireEvent.pointerDown(canvas, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 150, clientY: 50 });
  fireEvent.pointerMove(canvas, { pointerId: 2, pointerType: 'mouse', buttons: 1, clientX: 150, clientY: 52 });
  fireEvent.pointerUp(canvas, { pointerId: 2, pointerType: 'mouse', clientX: 150, clientY: 52 });
  expect(onStrokesChange).toHaveBeenLastCalledWith(0);
  fireEvent.click(container.querySelector('button[title="撤销（Ctrl+Z）"]')!);
  expect(onStrokesChange).toHaveBeenLastCalledWith(2);
});

it('快捷键：Ctrl+Z 撤销 / Ctrl+Shift+Z 与 Ctrl+Y 重做；输入框内不抢原生撤销', () => {
  const onStrokesChange = vi.fn();
  const { container } = render(
    <div>
      <input data-testid="field" />
      <HandwritingPad onStrokesChange={onStrokesChange} />
    </div>,
  );
  const canvas = container.querySelector('canvas')!;
  penLine(canvas, 50);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(onStrokesChange).toHaveBeenLastCalledWith(0);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
  expect(onStrokesChange).toHaveBeenLastCalledWith(1);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
  expect(onStrokesChange).toHaveBeenLastCalledWith(1);
  // 焦点在输入框：Ctrl+Z 交给浏览器撤销文字，不动笔迹
  const input = screen.getByTestId('field');
  input.focus();
  fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
  expect(onStrokesChange).toHaveBeenLastCalledWith(1);
});

it('提交式 clear()：笔迹与撤销栈一起清空（识别成功后不该再撤回笔迹）', () => {
  const ref = createRef<HandwritingPadHandle>();
  const onStrokesChange = vi.fn();
  const { container } = render(<HandwritingPad ref={ref} onStrokesChange={onStrokesChange} />);
  penLine(container.querySelector('canvas')!, 50);
  act(() => { ref.current!.clear(); });
  expect(onStrokesChange).toHaveBeenLastCalledWith(0);
  expect((container.querySelector('button[title="撤销（Ctrl+Z）"]') as HTMLButtonElement).disabled).toBe(true);
});

it('橡皮：擦过的笔画整条消失', () => {
  const ref = createRef<HandwritingPadHandle>();
  const onStrokesChange = vi.fn();
  const { container } = render(<HandwritingPad ref={ref} onStrokesChange={onStrokesChange} />);
  const canvas = container.querySelector('canvas')!;
  penLine(canvas, 50);
  fireEvent.click(container.querySelector('button[title="橡皮（快捷键 E）"]')!);
  // 划过笔画中段 (150,50)，容差 size(2)+8=10 → 命中整条擦除
  fireEvent.pointerDown(canvas, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 150, clientY: 50 });
  fireEvent.pointerUp(canvas, { pointerId: 2, pointerType: 'mouse', clientX: 150, clientY: 50 });
  expect(onStrokesChange).toHaveBeenLastCalledWith(0);
});
