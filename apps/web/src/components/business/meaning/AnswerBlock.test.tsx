import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AnswerBlock } from './AnswerBlock';

afterEach(() => cleanup());

const SENTENCE = { index: 1, text: '沉舟侧畔千帆过，病树前头万木春。', terms: [], answerable: true };

describe('AnswerBlock', () => {
  it('该句无重点字词时不渲染「重点字词」行', () => {
    render(<AnswerBlock sentence={SENTENCE} onSubmit={vi.fn()} />);
    expect(screen.queryByText('重点字词')).toBeNull();
    expect(screen.getByText('本句深层含义')).toBeTruthy();
    expect(screen.getByText('作者情感')).toBeTruthy();
  });

  it('有重点字词时每个词一个输入框', () => {
    const withTerms = { ...SENTENCE, terms: [{ term: '沉（chén）舟', plain: '沉舟' }] };
    render(<AnswerBlock sentence={withTerms} onSubmit={vi.fn()} />);
    expect(screen.getByText('重点字词')).toBeTruthy();
    expect(screen.getByLabelText('沉（chén）舟 释义')).toBeTruthy();
  });
});
