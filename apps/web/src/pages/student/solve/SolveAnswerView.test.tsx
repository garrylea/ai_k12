import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SolveAnswerView } from './SolveAnswerView';
import { beginImageDrag } from '@/components/business/draft-image-drag';

/**
 * 状态 C · 作答（考试第 9 题骨架，spec §8.5）。
 *
 * 契约要点：
 * 1. 题干在上（Markdown + LaTeX，经 preprocessMarkdown 归一），底部「答疑」+「提交」两个按钮；
 * 2. 题干图片带 dragToDraft：位移超过阈值交给页面级草稿拖拽（同 QuestionRunner 题面图）；
 * 3. submitting 时两个按钮都禁用，提交按钮文案变「提交中…」；
 * 4. 作答区上传状态经 onUploadingChange 透给父层（提交禁用态由父层 OR 进来）。
 */
vi.mock('@/components/business/draft-image-drag', () => ({
  beginImageDrag: vi.fn(),
  wasJustDragged: vi.fn(() => false),
}));

// 编辑器换成桩：本测试只验证「上传状态有没有被转发」，真实粘贴/上传链路由
// LatexEditor.test.tsx 覆盖；不 mock 的话需要构造文件 + 网络才能触发。
vi.mock('@/components/business/LatexEditor', () => ({
  LatexEditor: (props: { onUploadingChange?: (v: boolean) => void }) => (
    <div data-testid="latex-editor-stub">
      <button type="button" onClick={() => props.onUploadingChange?.(true)}>
        桩-上传开始
      </button>
      <button type="button" onClick={() => props.onUploadingChange?.(false)}>
        桩-上传结束
      </button>
    </div>
  ),
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

  it('卡片根节点有确定高度（h-full），作答区不再叠 min-h-0', () => {
    const { container } = renderView();
    // 根节点 h-full：max-h-[33%] 百分比与 LatexEditor/LatexPreview 的 h-full 都依赖它
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('h-full');
    expect(root.className).toContain('flex-col');
    // 作答行只留 min-h-[280px]
    const answerRow = root.children[1] as HTMLElement;
    expect(answerRow.className).toContain('min-h-[280px]');
    expect(answerRow.className.split(/\s+/)).not.toContain('min-h-0');
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

  it('已有流在跑时两个按钮都禁用，提交按钮不显示 loading 文案', () => {
    renderView({ answer: '答', streaming: true });
    expect(screen.getByRole('button', { name: '答疑' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '提交' })).toBeDisabled();
  });

  it('草稿面板收起（draftAvailable=false）时不显示「附上草稿」', () => {
    renderView({ draftAvailable: false, includeDraft: false });
    expect(screen.queryByRole('checkbox')).toBeNull();
    // 按钮不受影响
    expect(screen.getByRole('button', { name: '答疑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '提交' })).toBeTruthy();
  });

  it('勾选「附上草稿」把反值回传父层', () => {
    const onIncludeDraftChange = vi.fn();
    renderView({ includeDraft: true, onIncludeDraftChange });

    fireEvent.click(screen.getByRole('checkbox', { name: '附上草稿' }));
    expect(onIncludeDraftChange).toHaveBeenCalledWith(false);
  });

  it('点「答疑」/「提交」各自触发回调', () => {
    const onAskHelp = vi.fn();
    const onSubmit = vi.fn();
    renderView({ onAskHelp, onSubmit });

    fireEvent.click(screen.getByRole('button', { name: '答疑' }));
    expect(onAskHelp).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('作答区上传状态经 onUploadingChange 透给父层', () => {
    const onUploadingChange = vi.fn();
    renderView({ onUploadingChange });

    fireEvent.click(screen.getByRole('button', { name: '桩-上传开始' }));
    expect(onUploadingChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: '桩-上传结束' }));
    expect(onUploadingChange).toHaveBeenLastCalledWith(false);
  });

  it('底部按钮不参与压缩：窄卡下「答疑/提交」保持单行（不被压成竖排）', () => {
    renderView();
    for (const name of ['答疑', '提交']) {
      const btn = screen.getByRole('button', { name });
      // 底部栏是三等分 grid，中列在窄卡（草稿展开）时只有 ~140px；
      // 缺 nowrap/shrink-0 时按钮会被 flex 压窄，两个汉字各占一行（2026-11-11 报告）。
      expect(btn.className).toContain('whitespace-nowrap');
      expect(btn.className).toContain('shrink-0');
    }
  });

  it('题干经 preprocessMarkdown 归一：\\[…\\] 渲染成 KaTeX 而非字面方括号', () => {
    const { container } = renderView({ questionContent: '已知 \\[x=1\\]，求 x。' });

    expect(container.querySelector('.katex')).toBeTruthy();
    expect(container.textContent).not.toContain('[x=1]');
    expect(container.textContent).not.toContain('\\[');
  });
});
