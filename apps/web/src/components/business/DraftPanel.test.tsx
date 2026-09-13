import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, screen } from '@testing-library/react';
import { DraftPanel } from './DraftPanel';

/**
 * 草稿面板（并排占位式）：宽度与分割条行为。
 * 白板本身另有测试（DraftWhiteboard.test.tsx），这里换成占位 div，只测面板外壳。
 */
vi.mock('./DraftWhiteboard', () => ({
  DraftWhiteboard: () => <div data-testid="whiteboard" />,
}));

// vitest globals:false 下 @testing-library/react 不会自动注册 afterEach cleanup，
// 需手动清理，否则上个用例的 DOM 泄漏会让 getByRole 命中多个元素。
afterEach(() => cleanup());

beforeEach(() => {
  // jsdom 未实现指针捕获
  Object.defineProperty(Element.prototype, 'setPointerCapture', { value: () => {}, configurable: true });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { value: () => {}, configurable: true });
});

/** 渲染成「并排行」，并给行一个假宽度（jsdom 无布局，拖拽基准取行宽） */
function renderPanel() {
  const onClose = vi.fn();
  render(
    <div className="flex">
      <div className="flex-1" />
      <DraftPanel questionId="q1" draftKeyPrefix="tp" onClose={onClose} />
    </div>,
  );
  const splitter = screen.getByRole('separator');
  const panel = screen.getByRole('dialog', { name: '草稿' });
  const row = panel.parentElement!;
  row.getBoundingClientRect = () => ({
    width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
  return { splitter, panel, onClose };
}

/** 拖分割条：clientX 左移 = 面板变宽，右移 = 变窄（行宽 1000px → 100px = 10%） */
function drag(splitter: Element, fromX: number, toX: number) {
  fireEvent.pointerDown(splitter, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: fromX, clientY: 10 });
  fireEvent.pointerMove(splitter, { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: toX, clientY: 10 });
  fireEvent.pointerUp(splitter, { pointerId: 1, pointerType: 'mouse', clientX: toX, clientY: 10 });
}

describe('DraftPanel：并排 + 分割条调宽', () => {
  it('初始宽度 35%，且不再有「放大/缩小」按钮', async () => {
    // 宽度是模块级会话记忆：这里用全新模块实例拿「首次进入」的默认值
    vi.resetModules();
    const { DraftPanel: FreshPanel } = await import('./DraftPanel');
    render(
      <div className="flex">
        <FreshPanel questionId="q1" draftKeyPrefix="tp" onClose={() => {}} />
      </div>,
    );
    const panel = screen.getByRole('dialog', { name: '草稿' });
    expect(panel.style.width).toBe('35%');
    expect(screen.queryByTitle('放大')).toBeNull();
    expect(screen.queryByTitle('缩小')).toBeNull();
  });

  it('向右拖变窄夹到下限 25%，向左拖变宽夹到上限 55%', () => {
    const { splitter, panel } = renderPanel();

    drag(splitter, 500, 1000); // 右移 500px = 起始宽度 -50% → 夹到下限
    expect(panel.style.width).toBe('25%');

    drag(splitter, 500, 0); // 左移 500px = 起始宽度 +50% → 夹到上限
    expect(panel.style.width).toBe('55%');
  });

  it('双击分割条回到默认 35%', () => {
    const { splitter, panel } = renderPanel();

    drag(splitter, 500, 0); // 先拖到上限 55%
    expect(panel.style.width).toBe('55%');

    fireEvent.doubleClick(splitter);
    expect(panel.style.width).toBe('35%');
  });

  it('点面板头部「收起」触发 onClose', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByTitle('收起'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
