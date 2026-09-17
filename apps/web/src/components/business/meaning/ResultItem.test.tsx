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
        passageId: 12, sentenceIndex: 1, allCorrect: false,
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
        passageId: 12, sentenceIndex: 1, allCorrect: false,
        // toKeyTerms 把缺失的 gloss 降级成 ''，这里模拟题库没有标准释义
        terms: [{ term: '舟', correct: false, method: 'ai', standard: '', comment: null }],
        meaning: { correct: true, method: 'ai', standard: '含哲理', comment: null },
        emotion: { correct: true, method: 'ai', standard: '豁达乐观', comment: null },
      },
    };
    render(<ResultItem item={item} isNewest onRetry={vi.fn()} />);
    expect(screen.getByText('〔舟〕应为：（题库无标准释义）')).toBeTruthy();
  });
});
