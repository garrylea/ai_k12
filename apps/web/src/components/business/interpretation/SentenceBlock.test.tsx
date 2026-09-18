import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { InterpretationJudgeResult, InterpretationSentenceItem } from '@/services/api';
import SentenceBlock, { type InterpretationAnswerValue } from './SentenceBlock';

// vitest globals:false 下 @testing-library/react 不会自动注册 afterEach cleanup，
// 需手动清理，否则上一个用例的 DOM 泄漏到下一个用例导致选择器重复命中（同 QuestionRunner.test）。
afterEach(() => cleanup());

/**
 * 这是「三行对译」卡片的渲染契约测试。
 *
 * 起因（2026-09-16）：`terms` 从 `string[]` 改成 `{term, plain}` 之后，只跑了
 * `tsc + lint + build` 就上线，结果旧 bundle 配新接口直接把对象当 React child 渲染，
 * 线上报 **React #31**（Objects are not valid as a React child）。类型检查抓不到这种
 * 「运行时形状」问题——只有真的渲染一次才抓得到。此后本文件钉住两件事：
 *   1. `term`（带注音）用于展示、`plain`（去注音）用于在原文里高亮；
 *   2. 三种卡片状态（editing / judging / judged）都能渲染，且 undetermined 给「重新判题」。
 */

const SENTENCE: InterpretationSentenceItem = {
  index: 0,
  text: '庆历四年春，滕子京谪守巴陵郡。',
  terms: [
    { term: '滕子京谪（zhé）守巴陵郡', plain: '滕子京谪守巴陵郡' },
    { term: '越明年', plain: '越明年' }, // 不在本句 → 不该高亮，也不该报错
  ],
};

const EMPTY: InterpretationAnswerValue = { terms: {}, translation: '' };

function makeProps(overrides: Partial<ComponentProps<typeof SentenceBlock>> = {}) {
  return {
    sentence: SENTENCE,
    value: EMPTY,
    onChange: vi.fn(),
    state: 'editing' as const,
    result: null,
    isLast: false,
    onNext: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

const JUDGED: InterpretationJudgeResult = {
  passageId: 28,
  sentenceIndex: 0,
  allCorrect: false,
  terms: [
    { term: '滕子京谪（zhé）守巴陵郡', correct: false, method: 'ai', standard: '滕子京被贬官到岳州做知州', comment: '「谪」含因罪被贬之意' },
    { term: '越明年', correct: null, method: 'undetermined', standard: '到了第二年', comment: null },
  ],
  sentence: { correct: true, method: 'exact', standard: '庆历四年的春天，滕子京被贬到巴陵郡做太守。', comment: null },
  fullTranslation: null,
  pointsAwarded: 0,
};

describe('SentenceBlock — 渲染契约（terms 是 {term, plain} 对象）', () => {
  it('渲染不抛错，且 term 按原样（带注音）显示在标签里', () => {
    // 直接把对象当 child 渲染会抛 React #31；这条是那个线上故障的回归钉子
    expect(() => render(<SentenceBlock {...makeProps()} />)).not.toThrow();
    expect(screen.getByText('〔滕子京谪（zhé）守巴陵郡〕')).toBeInTheDocument();
  });

  it('原文高亮用去注音形式（正文里没有注音）', () => {
    const { container } = render(<SentenceBlock {...makeProps()} />);
    const marks = Array.from(container.querySelectorAll('span.underline'));
    const texts = marks.map((m) => m.textContent);
    expect(texts).toContain('滕子京谪守巴陵郡');
    // 找不到的词不硬塞，也不报错
    expect(texts).not.toContain('越明年');
  });

  it('原文照常渲染（不因高亮被打散）', () => {
    render(<SentenceBlock {...makeProps()} />);
    expect(screen.getByText(/庆历四年春/)).toBeInTheDocument();
  });

  it('该句没有字词时，行 2 整行不渲染', () => {
    render(<SentenceBlock {...makeProps({ sentence: { ...SENTENCE, terms: [] } })} />);
    expect(screen.queryByPlaceholderText('写出这个词的意思')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('把这句话译成白话')).toBeInTheDocument();
  });

  it('字词输入框按 term（带注音）作 key 读写学生答案', () => {
    const onChange = vi.fn();
    render(
      <SentenceBlock
        {...makeProps({ value: { terms: { '滕子京谪（zhé）守巴陵郡': '旧答案' }, translation: '' }, onChange })}
      />,
    );
    const input = screen.getByDisplayValue('旧答案');
    fireEvent.change(input, { target: { value: '新答案' } });
    expect(onChange).toHaveBeenCalledWith({
      terms: { '滕子京谪（zhé）守巴陵郡': '新答案' },
      translation: '',
    });
  });
});

describe('SentenceBlock — 三态', () => {
  it('editing：输入可编辑、显示「下一句」', () => {
    render(<SentenceBlock {...makeProps()} />);
    expect(screen.getByPlaceholderText('把这句话译成白话')).not.toBeDisabled();
    expect(screen.getByText('下一句')).toBeInTheDocument();
  });

  it('editing 且是最后一句：按钮文案为「完成本篇」', () => {
    render(<SentenceBlock {...makeProps({ isLast: true })} />);
    expect(screen.getByText('完成本篇')).toBeInTheDocument();
  });

  it('judging：输入锁定 + 显示「AI 正在判题…」', () => {
    render(<SentenceBlock {...makeProps({ state: 'judging' })} />);
    expect(screen.getByText('AI 正在判题…')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('把这句话译成白话')).toBeDisabled();
    expect(screen.queryByText('下一句')).not.toBeInTheDocument();
  });

  it('judged：逐项结果就地显示（对/错/未判定）+ 有未判定才给「重新判题」', () => {
    render(<SentenceBlock {...makeProps({ state: 'judged', result: JUDGED })} />);
    expect(screen.getByText(/滕子京被贬官到岳州做知州/)).toBeInTheDocument();
    expect(screen.getByText('未判定（AI 暂时没判出来，可点「重新判题」）')).toBeInTheDocument();
    expect(screen.getByText('重新判题')).toBeInTheDocument();
    // 学生答案保留在输入框里（与标准答案上下对照）
    expect(screen.getByPlaceholderText('把这句话译成白话')).toBeDisabled();
  });

  it('judged：全部判定完毕（无 undetermined）不显示「重新判题」', () => {
    const allDone: InterpretationJudgeResult = {
      ...JUDGED,
      terms: [{ term: '滕子京谪（zhé）守巴陵郡', correct: true, method: 'ai', standard: 's', comment: null }],
    };
    render(<SentenceBlock {...makeProps({ state: 'judged', result: allDone })} />);
    expect(screen.queryByText('重新判题')).not.toBeInTheDocument();
  });

  it('judged 但 result 为 null（请求本身失败）：给失败提示 + 「重新判题」', () => {
    render(<SentenceBlock {...makeProps({ state: 'judged', result: null })} />);
    expect(screen.getByText(/判题失败/)).toBeInTheDocument();
    expect(screen.getByText('重新判题')).toBeInTheDocument();
  });

  it('点「重新判题」调用 onRetry', () => {
    const onRetry = vi.fn();
    render(<SentenceBlock {...makeProps({ state: 'judged', result: JUDGED, onRetry })} />);
    fireEvent.click(screen.getByText('重新判题'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('点「下一句」调用 onNext', () => {
    const onNext = vi.fn();
    render(<SentenceBlock {...makeProps({ onNext })} />);
    fireEvent.click(screen.getByText('下一句'));
    expect(onNext).toHaveBeenCalledOnce();
  });
});
