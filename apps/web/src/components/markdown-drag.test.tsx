import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { MarkdownImg } from './markdown';
import { beginImageDrag, wasJustDragged } from './business/draft-image-drag';

vi.mock('./business/draft-image-drag', () => ({
  beginImageDrag: vi.fn(),
  wasJustDragged: vi.fn(() => false),
}));

beforeEach(() => {
  vi.mocked(beginImageDrag).mockClear();
  vi.mocked(wasJustDragged).mockReturnValue(false);
});
afterEach(() => { cleanup(); });

describe('MarkdownImg 拖源', () => {
  it('位移不超过 10px 不触发拖拽；超过才触发，且 src 走 resolveAsset', () => {
    const { container } = render(<MarkdownImg src="questions/a.png" alt="" dragToDraft />);
    const img = container.querySelector('img')!;

    fireEvent.pointerDown(img, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(img, { pointerId: 1, pointerType: 'touch', clientX: 5, clientY: 5 });
    expect(beginImageDrag).not.toHaveBeenCalled();

    fireEvent.pointerMove(img, { pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 0 });
    expect(beginImageDrag).toHaveBeenCalledWith({
      src: '/assets/questions/a.png', pointerId: 1, clientX: 20, clientY: 0,
    });
  });

  it('未开 dragToDraft 的图片不参与拖拽', () => {
    const { container } = render(<MarkdownImg src="questions/a.png" alt="" />);
    const img = container.querySelector('img')!;
    fireEvent.pointerDown(img, { pointerId: 1, isPrimary: true, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(img, { pointerId: 1, clientX: 40, clientY: 0 });
    expect(beginImageDrag).not.toHaveBeenCalled();
  });

  it('刚拖完的 click 不打开放大浮层', () => {
    vi.mocked(wasJustDragged).mockReturnValue(true);
    const { container } = render(<MarkdownImg src="questions/a.png" alt="" dragToDraft />);
    fireEvent.click(container.querySelector('img')!);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
