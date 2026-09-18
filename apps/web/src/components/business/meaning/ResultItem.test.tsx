import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ResultItem from './ResultItem';
import type { StackItem } from './types';

afterEach(() => cleanup());

const ANSWER = { terms: [{ term: '舟', answer: '船' }], meaning: '新事物必将取代旧事物', emotion: '豁达振奋' };

const BASE = {
  key: 'k1',
  sentenceIndex: 1,
  text: '沉舟侧畔千帆过',
  answer: ANSWER,
};

describe('ResultItem', () => {
  it('judged 项渲染标准答案与选项 label（不渲染对象本身——防 React #31 那类脏数据）', () => {
    const item: StackItem = {
      ...BASE,
      kind: 'judged',
      result: {
        passageId: 12, sentenceIndex: 1, allCorrect: false, pointsAwarded: 0,
        terms: [{ term: '舟', correct: false, method: 'ai', standard: '船', comment: '这里是比喻义' }],
        meaning: { correct: false, method: 'ai', standard: '含新事物代替旧事物的哲理', comment: null },
        emotion: { correct: true, method: 'ai', standard: '豁达乐观', comment: null },
      },
    };
    render(<ResultItem item={item} isNewest onRetry={vi.fn()} />);
    expect(screen.getByText(/深层含义：错误，应为：含新事物代替旧事物的哲理/)).toBeTruthy();
    expect(screen.getByText(/作者情感：正确/)).toBeTruthy();
    expect(screen.getByText(/你的：新事物必将取代旧事物/)).toBeTruthy();
    expect(screen.getByText('这里是比喻义')).toBeTruthy();
  });

  it('failed 项提示重试，pending 项显示判定中', () => {
    const { unmount } = render(
      <ResultItem item={{ ...BASE, kind: 'pending' }} isNewest onRetry={vi.fn()} />,
    );
    expect(screen.getByText('判定中…')).toBeTruthy();
    unmount();
    render(<ResultItem item={{ ...BASE, kind: 'failed' }} isNewest onRetry={vi.fn()} />);
    expect(screen.getByText(/判定失败/)).toBeTruthy();
  });

  it('标准答案为空 → 兜底文案，不留悬空「应为：」', () => {
    const item: StackItem = {
      ...BASE,
      kind: 'judged',
      result: {
        passageId: 12, sentenceIndex: 1, allCorrect: false, pointsAwarded: 0,
        // toKeyTerms 把缺失的 gloss 降级成 ''，这里模拟题库没有标准释义
        terms: [{ term: '舟', correct: false, method: 'ai', standard: '', comment: null }],
        meaning: { correct: true, method: 'ai', standard: '含哲理', comment: null },
        emotion: { correct: true, method: 'ai', standard: '豁达乐观', comment: null },
      },
    };
    render(<ResultItem item={item} isNewest onRetry={vi.fn()} />);
    expect(screen.getByText('〔舟〕应为：（题库无标准释义）')).toBeTruthy();
  });

  it('判对时用灰字给标准答案（含义/情感/字词都渲染）', () => {
    const item: StackItem = {
      ...BASE,
      kind: 'judged',
      result: {
        passageId: 12, sentenceIndex: 1, allCorrect: true, pointsAwarded: 0,
        terms: [{ term: '舟', correct: true, method: 'ai', standard: '船', comment: null }],
        meaning: { correct: true, method: 'ai', standard: '含新事物代替旧事物的哲理', comment: null },
        emotion: { correct: true, method: 'ai', standard: '豁达乐观', comment: null },
      },
    };
    render(<ResultItem item={item} isNewest onRetry={vi.fn()} />);

    // 「标准：」三行都在，且是灰字 token（不是判错的红色）
    const lines = screen.getAllByText(/^标准：/);
    expect(lines.map((el) => el.textContent)).toEqual([
      '标准：船',
      '标准：含新事物代替旧事物的哲理',
      '标准：豁达乐观',
    ]);
    for (const el of lines) {
      expect(el.className).toContain('text-[var(--text-secondary)]');
    }
    // 判对不该出现「应为：」那套判错文案
    expect(screen.queryByText(/应为：/)).toBeNull();
  });

  it('判对但题库没有标准答案 → 不渲染悬空的「标准：」', () => {
    const item: StackItem = {
      ...BASE,
      kind: 'judged',
      result: {
        passageId: 12, sentenceIndex: 1, allCorrect: true, pointsAwarded: 0,
        terms: [{ term: '舟', correct: true, method: 'ai', standard: '', comment: null }],
        meaning: { correct: true, method: 'ai', standard: '   ', comment: null },
        emotion: { correct: true, method: 'ai', standard: '', comment: null },
      },
    };
    render(<ResultItem item={item} isNewest onRetry={vi.fn()} />);
    expect(screen.queryByText(/^标准：/)).toBeNull();
  });

  it('重试是图标按钮：无文字，但可访问名仍是「重新判题」', () => {
    render(<ResultItem item={{ ...BASE, kind: 'failed' }} isNewest onRetry={vi.fn()} />);
    const btn = screen.getByRole('button', { name: '重新判题' });
    expect(btn.querySelector('svg')).toBeTruthy();          // 画的是线性 SVG
    expect(screen.queryByText('重新判题')).toBeNull();       // 不再有文字
    expect(btn.textContent).toBe('');                       // 按钮内无文本节点
  });
});
