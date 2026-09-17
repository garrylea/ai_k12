import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ResultStack from './ResultStack';
import type { StackItem } from './types';

// globals: false —— @testing-library/react 不会自动注册 cleanup，必须自己写
afterEach(() => cleanup());

const EMPTY_ANSWER = { terms: [], meaning: '', emotion: '' };

const JUDGED = (n: number): StackItem => ({
  kind: 'judged',
  key: `k${n}`,
  sentenceIndex: n,
  text: `第${n}句原文`,
  answer: EMPTY_ANSWER,
  result: {
    passageId: 12, sentenceIndex: n, allCorrect: true,
    terms: [], meaning: { correct: true, method: 'ai', standard: 'std', comment: null },
    emotion: { correct: true, method: 'ai', standard: 'std', comment: null },
  },
});

describe('ResultStack', () => {
  it('倒序渲染——最新一条排在最前面', () => {
    // items 就是页面持有的栈：新项 unshift 进头部，所以 index 0 = 最新。
    // 这里最新的是第 2 句（后作答），它必须先出现在 DOM 里。
    render(<ResultStack items={[JUDGED(2), JUDGED(1)]} onRetry={() => {}} />);
    const texts = screen.getAllByText(/第\d句原文/).map((el) => el.textContent);
    expect(texts[0]).toBe('第2句原文');
    expect(texts[1]).toBe('第1句原文');
  });

  it('pending 项显示「判定中…」', () => {
    render(
      <ResultStack
        items={[{ kind: 'pending', key: 'p1', sentenceIndex: 3, text: '沉舟侧畔千帆过', answer: EMPTY_ANSWER }]}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText(/判定中/)).toBeTruthy();
  });
});
