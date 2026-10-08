// InlineHandwritingPad.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import InlineHandwritingPad from './InlineHandwritingPad';
import { transcribeHandwriting } from '@/services/api';

vi.mock('@/services/api', () => ({ transcribeHandwriting: vi.fn() }));

const PNG = 'data:image/png;base64,AAA';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        clearRect() {}, setTransform() {}, beginPath() {}, arc() {}, fill() {},
        moveTo() {}, lineTo() {}, quadraticCurveTo() {}, stroke() {},
        save() {}, restore() {}, fillRect() {},
      }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG);
  Object.defineProperty(Element.prototype, 'setPointerCapture', { value: () => {}, configurable: true });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { value: () => {}, configurable: true });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      disconnect() {}
    };
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

/** 在指定画布上写一笔 */
function drawStroke(canvas: HTMLCanvasElement): void {
  fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: 50 });
  fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 160, clientY: 50 });
  fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'mouse', clientX: 160, clientY: 50 });
}

/** 渲染展开态，写一笔，返回回调 mock */
function setup(props: Partial<Parameters<typeof InlineHandwritingPad>[0]> = {}) {
  const onRecognized = vi.fn();
  const onClose = vi.fn();
  render(<InlineHandwritingPad open multiline onRecognized={onRecognized} onClose={onClose} {...props} />);
  drawStroke(document.querySelector('canvas')!);
  return { onRecognized, onClose };
}

describe('InlineHandwritingPad', () => {
  it('open=false 渲染 null；open=true 有 canvas 与「键盘」收起钮', () => {
    const { rerender } = render(<InlineHandwritingPad open={false} onRecognized={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('canvas')).toBeNull();
    rerender(<InlineHandwritingPad open onRecognized={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('canvas')).toBeTruthy();
    expect(screen.getByRole('button', { name: '切换到键盘输入' })).toBeTruthy();
  });

  it('识别成功：onRecognized 收到原文，面板清空可继续写（再画一笔识别钮恢复可用）', async () => {
    vi.mocked(transcribeHandwriting).mockResolvedValue({ text: '先天下之忧而忧', modelKey: 'local', elapsedMs: 90 });
    const { onRecognized } = setup();
    fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
    await waitFor(() => expect(onRecognized).toHaveBeenCalledWith('先天下之忧而忧'));
    // 面板已清空：无笔画 → 识别钮按设计禁用；再画一笔即可继续识别（未被识别流锁死）
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '识别并追加' })).toBeDisabled(),
    );
    drawStroke(document.querySelector('canvas')!);
    expect(screen.getByRole('button', { name: '识别并追加' })).not.toBeDisabled();
  });

  it('识别失败：显示错误可重试，onRecognized 不被调', async () => {
    vi.mocked(transcribeHandwriting).mockRejectedValue(new Error('识别模型调用失败：boom'));
    const { onRecognized } = setup();
    fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
    expect(onRecognized).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '识别并追加' })).not.toBeDisabled();
  });

  it('【键盘】收起调 onClose；无笔画时识别禁用；disabled 时识别禁用', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: '切换到键盘输入' }));
    expect(onClose).toHaveBeenCalled();

    // 独立实例（scoped 查询，避免与上一实例混淆）：无笔画 → 识别禁用
    const view = render(<InlineHandwritingPad open onRecognized={vi.fn()} onClose={vi.fn()} />);
    const recognizeBtn = () => within(view.container).getByRole('button', { name: '识别并追加' });
    expect(recognizeBtn()).toBeDisabled();

    // 画一笔 → 识别可用（证明上一步禁用确由「无笔画」导致）
    drawStroke(view.container.querySelector('canvas')!);
    expect(recognizeBtn()).not.toBeDisabled();

    // rerender disabled → 仍禁用（disabled prop 生效，而非笔画数）
    view.rerender(<InlineHandwritingPad open disabled onRecognized={vi.fn()} onClose={vi.fn()} />);
    expect(recognizeBtn()).toBeDisabled();
  });
});
