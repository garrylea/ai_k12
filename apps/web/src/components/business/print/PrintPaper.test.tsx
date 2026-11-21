import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { PrintPaper } from './PrintPaper';
import type { RunnerQuestion } from '@/components/business/answer/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const q = (over: Partial<RunnerQuestion>): RunnerQuestion => ({ n: '1', text: '题面', ...over });

describe('PrintPaper', () => {
  it('题号按顺序连续 1..N，忽略 n 字段', () => {
    render(
      <PrintPaper
        meta={{ subject: '数学', date: '2026-11-18' }}
        questions={[q({ n: '101' }), q({ n: '205' }), q({ n: '309' })]}
      />,
    );
    const nos = [...document.querySelectorAll('.print-q-no')].map((el) => el.textContent);
    expect(nos).toEqual(['1.', '2.', '3.']);
    expect(screen.getByText('数学专项 · 3 题')).toBeTruthy();
    expect(screen.getByText('2026-11-18')).toBeTruthy();
  });

  it('相邻同材料只印一次，不相邻同材料各印一次', () => {
    render(
      <PrintPaper
        questions={[
          q({ n: '1', material: '共享文段' }),
          q({ n: '2', material: '共享文段' }),
          q({ n: '3' }),
          q({ n: '4', material: '共享文段' }),
        ]}
      />,
    );
    expect(screen.getAllByTestId('print-material-text')).toHaveLength(2);
  });

  it('同 materialUrl 的连续题只印一次', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '## 文章' }));
    render(<PrintPaper questions={[
      { n: '1', text: '题1', materialUrl: 'materials/chinese/a/content.md' },
      { n: '2', text: '题2', materialUrl: 'materials/chinese/a/content.md' },
    ]} />);
    expect(screen.getAllByTestId('print-material')).toHaveLength(1);
  });

  it('同文章 + 题中素材：文章只印一次，14 题的题中素材仍印', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '## 醉翁亭记' }));
    render(<PrintPaper questions={[
      { n: '12', text: '题12', materialUrl: 'materials/chinese/k6/content.md' },
      { n: '13', text: '题13', materialUrl: 'materials/chinese/k6/content.md' },
      { n: '14', text: '题14', materialUrl: 'materials/chinese/k6/content.md',
        material: '《沧浪亭记》\n\n注：①罪废' },
    ]} />);
    const docBlocks = screen.getAllByTestId('print-material');
    const textBlocks = screen.getAllByTestId('print-material-text');
    expect(docBlocks).toHaveLength(1);
    expect(textBlocks).toHaveLength(1);
    await waitFor(() => expect(docBlocks[0].textContent).toContain('醉翁亭记'));
    expect(textBlocks[0].textContent).toContain('沧浪亭记');
    expect(textBlocks[0].textContent).toContain('注：①罪废');
    // 文章 → 题干 → 题中素材
    const sheetText = screen.getByTestId('print-sheet').textContent ?? '';
    expect(sheetText.indexOf('醉翁亭记')).toBeLessThan(sheetText.indexOf('题14'));
    expect(sheetText.indexOf('题14')).toBeLessThan(sheetText.indexOf('沧浪亭记'));
  });

  it('选择题打印选项且不留作答空白；填空题短空白、主观题长空白', () => {
    render(
      <PrintPaper
        questions={[
          q({
            n: '1',
            type: 'choice',
            options: [
              { label: 'A', text: '选项甲' },
              { label: 'B', text: '选项乙' },
            ],
          }),
          q({ n: '2', type: 'fill_blank' }),
          q({ n: '3', type: 'short_answer' }),
        ]}
      />,
    );
    expect(screen.getByText('选项甲')).toBeTruthy();
    expect(screen.getByText('选项乙')).toBeTruthy();
    const blanks = screen.getAllByTestId('answer-space');
    expect(blanks).toHaveLength(2);
    expect(blanks[0].className).toContain('print-answer-blank--short');
    expect(blanks[1].className).toContain('print-answer-blank--long');
  });

  it('true_false 不带选项时补「对 / 错」', () => {
    render(<PrintPaper questions={[q({ type: 'true_false' })]} />);
    expect(screen.getByText('对')).toBeTruthy();
    expect(screen.getByText('错')).toBeTruthy();
  });

  it('不渲染答案与解析', () => {
    render(<PrintPaper questions={[q({ n: '1', text: '题面文字' })]} />);
    expect(screen.queryByText(/参考答案/)).toBeNull();
    expect(screen.queryByText(/解析/)).toBeNull();
  });
});
