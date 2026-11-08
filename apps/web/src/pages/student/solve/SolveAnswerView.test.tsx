import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SolveAnswerView } from './SolveAnswerView';
import { beginImageDrag } from '@/components/business/draft-image-drag';

/**
 * 状态 C · 作答（考试第 9 题骨架，spec §8.5）。
 *
 * 契约要点：
 * 1. 题干在上（Markdown + LaTeX），底部「答疑」+「提交」两个按钮；
 * 2. 题干图片带 dragToDraft：位移超过阈值交给页面级草稿拖拽（同 QuestionRunner 题面图）；
 * 3. submitting 时两个按钮都禁用，提交按钮文案变「提交中…」。
 */
vi.mock('@/components/business/draft-image-drag', () => ({
  beginImageDrag: vi.fn(),
  wasJustDragged: vi.fn(() => false),
}));

beforeEach(() => {
  vi.mocked(beginImageDrag).mockClear();
});
afterEach(() => cleanup());

function renderView(overrides: Partial<Parameters<typeof SolveAnswerView>[0]> = {}) {
  const props: Parameters<typeof SolveAnswerView>[0] = {
    questionContent: '题干 ![图](/uploads/a.jpg)',
    answer: '',
    onAnswerChange: () => {},
    includeDraft: true,
    onIncludeDraftChange: () => {},
    submitting: false,
    onAskHelp: () => {},
    onSubmit: () => {},
    ...overrides,
  };
  return render(<SolveAnswerView {...props} />);
}

describe('SolveAnswerView', () => {
  it('题干图片带 dragToDraft，底部两个按钮', () => {
    const { container } = renderView();
    expect(screen.getByRole('button', { name: '答疑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '提交' })).toBeTruthy();
    // markdown 渲染的 img 有 pointerdown（dragToDraft 链路）
    const img = container.querySelector('img[alt="图"]') as HTMLImageElement;
    expect(img).toBeTruthy();
  });

  it('拖动题干图片超过阈值会起拖（dragToDraft 交给页面级草稿面板）', () => {
    const { container } = renderView();
    const img = container.querySelector('img[alt="图"]') as HTMLImageElement;

    fireEvent.pointerDown(img, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(img, { pointerId: 1, pointerType: 'touch', clientX: 5, clientY: 5 });
    expect(beginImageDrag).not.toHaveBeenCalled();

    fireEvent.pointerMove(img, { pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 0 });
    expect(beginImageDrag).toHaveBeenCalledWith({
      src: '/uploads/a.jpg',
      pointerId: 1,
      clientX: 20,
      clientY: 0,
    });
  });

  it('提交中禁用两个按钮', () => {
    renderView({ answer: '答', submitting: true });
    expect(screen.getByRole('button', { name: '答疑' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '提交中…' })).toBeDisabled();
  });
});
