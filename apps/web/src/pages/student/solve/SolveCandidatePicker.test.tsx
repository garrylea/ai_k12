import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SolveCandidatePicker } from './SolveCandidatePicker';
import type { FreeformCandidate, FreeformFigure } from '@/services/api';

/**
 * 状态 B · 选题（spec §8.4）。
 *
 * 契约要点：
 * 1. 默认选中第一道题，配图预选 = 该题的 `figureUrls`；配图可多选；
 * 2. 切题把题干 / 配图 / 学科都重置为该题的建议值；
 * 3. `onConfirm` 的 content 去掉未勾选配图的 Markdown，追加勾选但未出现的配图；
 * 4. figureUrls 按配图展示顺序返回；subjectId 按 math=1 / physics=4 / chemistry=5；
 * 5. 提交内容（删掉未勾选图之后）为空、或满分越界（<1 / >100）时「开始作答」不可用。
 */

const CANDIDATES: FreeformCandidate[] = [
  {
    id: 'c1',
    no: '5',
    content: '题干一 ![a](/uploads/freeform/a.jpg)',
    figureUrls: ['/uploads/freeform/a.jpg'],
    suggestedSubject: 'math',
    confidence: 0.9,
  },
  {
    id: 'c2',
    no: '6',
    content: '题干二',
    figureUrls: [],
    suggestedSubject: 'physics',
    confidence: 0.8,
  },
];

const FIGURES: FreeformFigure[] = [
  { url: '/uploads/freeform/a.jpg', name: 'a.jpg', page: 1 },
  { url: '/uploads/freeform/b.jpg', name: 'b.jpg', page: 1 },
];

afterEach(() => cleanup());

function renderPicker(
  candidates: FreeformCandidate[] = CANDIDATES,
  figures: FreeformFigure[] = FIGURES,
) {
  const onConfirm = vi.fn();
  const onBack = vi.fn();
  render(
    <SolveCandidatePicker
      candidates={candidates}
      figures={figures}
      onBack={onBack}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onBack };
}

describe('SolveCandidatePicker', () => {
  it('默认选第一题、配图预选；可多选配图', () => {
    const { onConfirm } = renderPicker();
    expect(screen.getByText('第 5 题')).toBeTruthy();
    const checks = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checks.filter((c) => c.checked).length).toBe(1);

    fireEvent.click(screen.getByLabelText('b.jpg'));
    fireEvent.click(screen.getByRole('button', { name: '开始作答' }));

    expect(onConfirm.mock.calls[0][0].figureUrls).toEqual([
      '/uploads/freeform/a.jpg',
      '/uploads/freeform/b.jpg',
    ]);
  });

  it('切到第二题，学科跟随预选', () => {
    const { onConfirm } = renderPicker();
    fireEvent.click(screen.getByText('第 6 题'));
    fireEvent.click(screen.getByRole('button', { name: '开始作答' }));
    expect(onConfirm.mock.calls[0][0].subjectId).toBe(4);
  });

  it('取消勾选会把该图 Markdown 从题干删掉，新勾的图追加到题干', () => {
    const { onConfirm } = renderPicker();
    fireEvent.click(screen.getByLabelText('a.jpg'));
    fireEvent.click(screen.getByLabelText('b.jpg'));
    fireEvent.click(screen.getByRole('button', { name: '开始作答' }));

    const { content } = onConfirm.mock.calls[0][0];
    expect(content).toContain('题干一');
    expect(content).not.toContain('/uploads/freeform/a.jpg');
    expect(content).toContain('![配图](/uploads/freeform/b.jpg)');
  });

  it('切题同时重置题干与配图勾选', () => {
    const { onConfirm } = renderPicker();
    fireEvent.click(screen.getByLabelText('b.jpg'));
    fireEvent.click(screen.getByText('第 6 题'));
    fireEvent.click(screen.getByRole('button', { name: '开始作答' }));

    const payload = onConfirm.mock.calls[0][0];
    expect(payload.content).toBe('题干二');
    expect(payload.figureUrls).toEqual([]);
  });

  it('点题干就地变源码框，点框外回到渲染并显示改后内容', () => {
    renderPicker();
    // 默认选中的是第一题：点它的题干即可编辑
    fireEvent.click(screen.getAllByTestId('stem-render')[0]);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe(CANDIDATES[0].content);

    fireEvent.change(textarea, { target: { value: '改后的 $x^2$ 题干' } });
    fireEvent.blur(textarea);

    // blur 后回到渲染态：源码框消失，渲染的是改后内容（KaTeX 生效），且不残留识别原文
    expect(screen.queryByRole('textbox')).toBeNull();
    const rendered = screen.getAllByTestId('stem-render')[0];
    expect(rendered.textContent).toContain('改后的');
    expect(rendered.textContent).not.toContain('题干一');
    expect(rendered.querySelector('.katex'), '渲染态仍走 Markdown + KaTeX').not.toBeNull();
  });

  it('换题不进入编辑态（只有点选中卡的题干才编辑）', () => {
    renderPicker();
    fireEvent.click(screen.getByText('第 6 题'));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getAllByTestId('stem-render')[1].textContent).toContain('题干二');
  });

  it('编辑题干后可以恢复到识别结果', () => {
    renderPicker();
    fireEvent.click(screen.getAllByTestId('stem-render')[0]);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '改过的题干' } });

    fireEvent.click(screen.getByRole('button', { name: '恢复识别结果' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(CANDIDATES[0].content);
  });

  it('题干清空后渲染态给占位提示，且「开始作答」不可点', () => {
    renderPicker(CANDIDATES, []);
    fireEvent.click(screen.getAllByTestId('stem-render')[0]);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.blur(screen.getByRole('textbox'));

    expect(screen.getAllByTestId('stem-render')[0].textContent).toContain('题干为空');
    expect((screen.getByRole('button', { name: '开始作答' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('题干为空或满分越界时不能提交', () => {
    const { onConfirm } = renderPicker();
    const submit = screen.getByRole('button', { name: '开始作答' }) as HTMLButtonElement;

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '101' } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    expect(submit.disabled).toBe(false);

    fireEvent.click(screen.getAllByTestId('stem-render')[0]);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    // 只清文字不够：勾选的 a.jpg 会被补回题干，必须连配图一起取消才算空。
    fireEvent.click(screen.getByLabelText('a.jpg'));
    expect(submit.disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('默认 payload：subjectId=1、maxScore=10', () => {
    const { onConfirm } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: '开始作答' }));

    const payload = onConfirm.mock.calls[0][0];
    expect(payload.subjectId).toBe(1);
    expect(payload.maxScore).toBe(10);
  });

  it('题干只有图、该图取消勾选后不能提交', () => {
    const imageOnly: FreeformCandidate[] = [
      {
        id: 'c1',
        no: '5',
        content: '![x](/uploads/freeform/a.jpg)',
        figureUrls: ['/uploads/freeform/a.jpg'],
        suggestedSubject: 'math',
        confidence: 0.9,
      },
    ];
    const { onConfirm } = renderPicker(imageOnly);
    const submit = screen.getByRole('button', { name: '开始作答' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    fireEvent.click(screen.getByLabelText('a.jpg'));
    expect(submit.disabled).toBe(true);

    fireEvent.click(submit);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('已出现在题干里的勾选配图不会重复追加', () => {
    const { onConfirm } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: '开始作答' }));

    const { content } = onConfirm.mock.calls[0][0];
    expect(content.match(/!\[[^\]]*\]\(\/uploads\/freeform\/a\.jpg\)/g)).toHaveLength(1);
  });

  it('无配图时不显示「配图（多选）」区块', () => {
    renderPicker(CANDIDATES, []);
    expect(screen.queryByText('配图（多选）')).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('题干按 Markdown + LaTeX 渲染（不是原始 $ 文本）', () => {
    const withMath: FreeformCandidate[] = [
      {
        id: 'c1',
        no: '7',
        content: '求 $x^2$ 的值',
        figureUrls: [],
        suggestedSubject: 'math',
        confidence: 0.9,
      },
    ];
    renderPicker(withMath, []);
    // KaTeX 生成 .katex 节点即证明走了 renderer；若仍是纯文本则不会有该节点。
    expect(document.querySelector('.katex')).not.toBeNull();
    expect(screen.queryByText('求 $x^2$ 的值')).toBeNull();
  });

  it('点图片放大不改变勾选态，并打开大图', () => {
    renderPicker();
    const checkbox = screen.getByLabelText('a.jpg') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '放大 a.jpg' }));

    const lightbox = screen.getByTestId('image-lightbox');
    expect(lightbox.querySelector('img')?.getAttribute('src')).toBe('/uploads/freeform/a.jpg');
    expect(checkbox.checked).toBe(true);
  });

  it('点复选框只切换勾选，不打开大图', () => {
    renderPicker();
    fireEvent.click(screen.getByLabelText('a.jpg'));

    expect((screen.getByLabelText('a.jpg') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
  });

  it('满分不是整数时不能提交', () => {
    renderPicker();
    const submit = screen.getByRole('button', { name: '开始作答' }) as HTMLButtonElement;

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '10.5' } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '10' } });
    expect(submit.disabled).toBe(false);
  });
});
