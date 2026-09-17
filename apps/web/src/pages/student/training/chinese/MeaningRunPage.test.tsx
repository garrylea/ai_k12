import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import MeaningRunPage from '@/pages/student/training/chinese/MeaningRunPage';
import { judgeMeaning, type MeaningJudgeResult } from '@/services/api';

// globals: false —— @testing-library/react 不会自动注册 cleanup，必须自己写
afterEach(() => cleanup());

// 只替换判题接口，其余保持真身（page 树里没有其它地方调 API）
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, judgeMeaning: vi.fn() };
});

const judgeMock = vi.mocked(judgeMeaning);

const PASSAGE = {
  passageId: 12,
  workTitle: '酬乐天扬州初逢席上见赠',
  semester: '上册',
  sentences: [
    { index: 0, text: '巴山楚水凄凉地', terms: [], answerable: true },
    { index: 1, text: '二十三年弃置身', terms: [], answerable: false },  // 不该被渲染成作答句
    { index: 2, text: '沉舟侧畔千帆过', terms: [{ term: '沉舟', plain: '沉船' }], answerable: true },
  ],
};

/** 三句可作答 —— 重试保序这条用例需要至少 3 句才能看出「挪到头部」的变化。 */
const PASSAGE_3 = {
  ...PASSAGE,
  sentences: [
    ...PASSAGE.sentences,
    { index: 3, text: '暂凭杯酒长精神', terms: [], answerable: true },
  ],
};

/** 受控的判题结果：让测试能决定两个调用谁先回来（过期令牌用例要用）。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const RESULT = (sentenceIndex: number): MeaningJudgeResult => ({
  passageId: 12,
  sentenceIndex,
  allCorrect: false,
  terms: [],
  meaning: { correct: false, method: 'ai', standard: `第${sentenceIndex + 1}句标准含义`, comment: null },
  emotion: { correct: true, method: 'ai', standard: '豁达', comment: null },
});

beforeEach(() => {
  sessionStorage.setItem('training:meaning', JSON.stringify([PASSAGE]));
  judgeMock.mockReset();
  // 默认永不返回 —— 让每次提交都停在 pending，便于断言「已作答但未判定」的中间态
  judgeMock.mockReturnValue(new Promise(() => {}));
});

/** RunExitGuard 用 useBlocker —— 必须是 data router（createMemoryRouter），不能用 MemoryRouter。 */
const renderPage = () => {
  const router = createMemoryRouter([{ path: '/', element: <MeaningRunPage /> }], {
    initialEntries: ['/'],
  });
  return render(<RouterProvider router={router} />);
};

const renderWith = (passage: unknown) => {
  sessionStorage.setItem('training:meaning', JSON.stringify([passage]));
  return renderPage();
};

/** 填一句含义再提交（空答案会禁用提交按钮）。 */
const submitCurrent = (meaning: string) => {
  fireEvent.change(screen.getByRole('textbox', { name: '本句深层含义' }), { target: { value: meaning } });
  fireEvent.click(screen.getByRole('button', { name: '提交' }));
};

/**
 * 结果栈里每一行的原文，顺序即 DOM 顺序。
 * 从「第 N 句」标签横向取其右边的原文段落 —— 顶部全诗原文条里有同样的句子，纵向查会撞车。
 */
const stackSentences = () =>
  screen.getAllByText(/^第 \d+ 句$/).map((el) => el.parentElement!.nextElementSibling!.textContent ?? '');

describe('MeaningRunPage', () => {
  it('一次只渲染当前句；answerable:false 的句子不进作答区（但原文条里有）', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: '古诗含义' })).toBeTruthy();
    // 第 1 句是当前句 → 它的原文出现在作答区；「二十三年弃置身」只在全诗原文条里
    expect(screen.getByText('本句深层含义')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '本句深层含义' })).toBeTruthy();
    // 可作答句只有 2 句（index 1 的 answerable:false 不计数）
    expect(screen.getByText(/第 1 \/ 2 句/)).toBeTruthy();
  });

  it('倒序契约：后提交的那句排在结果栈最前（判定还没回来就已经成立）', () => {
    renderPage();
    submitCurrent('答第 1 句');
    submitCurrent('答第 3 句');

    // 两句都还是 pending —— 顺序不能依赖「模型回来了才算数」
    expect(screen.getAllByText('判定中…')).toHaveLength(2);
    expect(stackSentences()).toEqual(['沉舟侧畔千帆过', '巴山楚水凄凉地']);
  });

  it('提交后立刻占位「判定中…」，作答区不等待直接推进下一句', () => {
    renderPage();
    submitCurrent('答第 1 句');
    expect(screen.getByText('判定中…')).toBeTruthy();
    // 已经到第 3 句：该句带重点字词「沉舟」，靠它的输入框确认作答区换了句
    expect(screen.getByLabelText('沉舟 释义')).toBeTruthy();
  });

  it('判定结果回来后原地替换占位项（不追加、位置不变）', async () => {
    const pending = deferred<MeaningJudgeResult>();
    judgeMock.mockReturnValueOnce(pending.promise);
    renderPage();
    submitCurrent('答第 1 句');
    expect(stackSentences()).toEqual(['巴山楚水凄凉地']);

    await act(async () => { pending.resolve(RESULT(0)); });

    expect(screen.queryByText('判定中…')).toBeNull();
    expect(stackSentences()).toEqual(['巴山楚水凄凉地']);   // 仍是一条，位置没变
    expect(screen.getByText(/深层含义：错误，应为：第1句标准含义/)).toBeTruthy();
  });

  it('过期响应丢弃：同一句重新判题后，旧调用的结果不覆盖新占位', async () => {
    const first = deferred<MeaningJudgeResult>();
    const second = deferred<MeaningJudgeResult>();
    judgeMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderPage();
    submitCurrent('答第 1 句');
    fireEvent.click(screen.getByRole('button', { name: '重新判题' }));  // 同一句再来一次 → 新令牌

    await act(async () => { first.resolve(RESULT(0)); });
    // 旧令牌已作废 → 仍是判定中，也没渲染出旧结果
    expect(screen.getByText('判定中…')).toBeTruthy();
    expect(screen.queryByText(/深层含义：/)).toBeNull();

    await act(async () => { second.resolve(RESULT(0)); });
    expect(screen.queryByText('判定中…')).toBeNull();
    expect(screen.getByText(/深层含义：错误，应为：第1句标准含义/)).toBeTruthy();
  });

  it('重新判题不打乱栈内顺序（原地替换，不挪到最前）', () => {
    renderWith(PASSAGE_3);
    submitCurrent('答第 1 句');
    submitCurrent('答第 3 句');
    submitCurrent('答第 4 句');
    expect(stackSentences()).toEqual(['暂凭杯酒长精神', '沉舟侧畔千帆过', '巴山楚水凄凉地']);

    // 重试最早那句（栈尾）→ 顺序不变，且它重新变成 pending
    fireEvent.click(screen.getAllByText('重新判题')[2]);
    expect(stackSentences()).toEqual(['暂凭杯酒长精神', '沉舟侧畔千帆过', '巴山楚水凄凉地']);
    expect(screen.getAllByText('判定中…')).toHaveLength(3);
  });

  it('已作答但还在判定的句子在原文条里也置灰（不等模型返回）', () => {
    const { container } = renderPage();
    const overview = () => Array.from(container.querySelectorAll('ol li'));
    expect(overview()[0].className).not.toContain('opacity-50');

    submitCurrent('答第 1 句');
    expect(overview()[0].className).toContain('opacity-50');   // 已答（pending 也算）
    expect(overview()[2].className).not.toContain('opacity-50');  // 下一句还没答
  });
});
