// apps/web/src/components/business/handwriting/HandwritingInputModal.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import HandwritingInputModal from './HandwritingInputModal';
import { transcribeHandwriting } from '@/services/api';

vi.mock('@/services/api', () => ({ transcribeHandwriting: vi.fn() }));

const PNG = 'data:image/png;base64,AAA';

beforeEach(() => {
  // jsdom 无 canvas 2d（模式同 DraftWhiteboard.test.tsx）
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    clearRect() {}, setTransform() {}, beginPath() {}, arc() {}, fill() {},
    moveTo() {}, lineTo() {}, quadraticCurveTo() {}, stroke() {},
    save() {}, restore() {}, fillRect() {},
  }) as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG);
  Object.defineProperty(Element.prototype, 'setPointerCapture', { value: () => {}, configurable: true });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { value: () => {}, configurable: true });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class { observe() {} disconnect() {} };
});

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

/** 渲染打开态弹层，画一笔，返回常用句柄 */
function setup() {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(<HandwritingInputModal open title="手写输入：作者" onConfirm={onConfirm} onClose={onClose} />);
  const canvas = document.querySelector('canvas')!;
  fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: 50 });
  fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 160, clientY: 50 });
  fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'mouse', clientX: 160, clientY: 50 });
  return { onConfirm, onClose, canvas };
}

describe('HandwritingInputModal', () => {
  it('初始：校对区空，确认填入禁用；识别成功追加到校对区并清空面板', async () => {
    vi.mocked(transcribeHandwriting).mockResolvedValue({ text: '范仲淹', modelKey: 'local', elapsedMs: 100 });
    const { onConfirm } = setup();
    const confirmBtn = screen.getByRole('button', { name: '确认填入' });
    expect(confirmBtn).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
    const pad = document.querySelector('canvas')!;
    await waitFor(() => expect(screen.getByRole('textbox', { name: '校对区' })).toHaveValue('范仲淹'));
    // 识别后面板已清空（无笔画 → 识别按钮禁用）
    expect(screen.getByRole('button', { name: '识别并追加' })).toBeDisabled();
    expect(confirmBtn).not.toBeDisabled();
    // 确认回填：onConfirm 收到校对区全文
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledWith('范仲淹');
    expect(pad).toBeTruthy();
  });

  it('分批追加：校对区非空且结尾非换行时自动补换行', async () => {
    vi.mocked(transcribeHandwriting)
      .mockResolvedValueOnce({ text: '先天下之忧而忧', modelKey: 'local', elapsedMs: 90 })
      .mockResolvedValueOnce({ text: '后天下之乐而乐', modelKey: 'local', elapsedMs: 90 });
    const { canvas } = setup();
    const pad = canvas;
    const stroke = () => {
      fireEvent.pointerDown(pad, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: 50 });
      fireEvent.pointerUp(pad, { pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 50 });
    };
    stroke();
    fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '校对区' })).toHaveValue('先天下之忧而忧'));
    stroke();
    fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '校对区' })).toHaveValue('先天下之忧而忧\n后天下之乐而乐'),
    );
  });

  it('识别失败：显示错误、笔迹保留可重试；成功后错误消失', async () => {
    vi.mocked(transcribeHandwriting)
      .mockRejectedValueOnce(new Error('识别模型调用失败：boom'))
      .mockResolvedValueOnce({ text: '宋', modelKey: 'local', elapsedMs: 80 });
    setup();
    fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
    // 失败后笔迹保留 → 识别按钮仍可用（重试）
    expect(screen.getByRole('button', { name: '识别并追加' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '校对区' })).toHaveValue('宋'));
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  it('open=false 不渲染；onClose 在点关闭时被调', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <HandwritingInputModal open={false} title="t" onConfirm={vi.fn()} onClose={onClose} />,
    );
    expect(document.querySelector('canvas')).toBeNull();
    rerender(<HandwritingInputModal open title="t" onConfirm={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalled();
  });
});
