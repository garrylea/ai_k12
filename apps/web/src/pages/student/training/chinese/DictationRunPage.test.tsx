import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import DictationRunPage from './DictationRunPage';
import {
  fetchDictationFeedback,
  judgeDictation,
  type DictationJudgeResult,
  type DictationQuestionItem,
} from '@/services/api';
import { usePointsStore } from '@/store/pointsStore';
import { PointsToast } from '@/components/business/PointsToast';

/**
 * 古诗文默写答题页接发分反馈（计划 §3 Task 7c）。
 *
 * 甲类：整篇按 genre 档发一次分，分就在判题响应里（`pointsAwarded` / `awardReason`），
 * 本页**不调**任何完成接口。钉住：发分 push 参数正确、幂等命中静默、已达上限弹中性文案。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 */
afterEach(() => {
  cleanup();
  usePointsStore.setState({ queue: [], revision: 0 });
  sessionStorage.clear();
});

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, judgeDictation: vi.fn(), fetchDictationFeedback: vi.fn() };
});

const judgeMock = vi.mocked(judgeDictation);
const feedbackMock = vi.mocked(fetchDictationFeedback);

const QUESTION: DictationQuestionItem = {
  passageId: 5,
  prompt: '请默写《岳阳楼记》',
  workTitle: '岳阳楼记',
  semester: '下册',
};

function judged(overrides: Partial<DictationJudgeResult> = {}): DictationJudgeResult {
  return {
    passageId: 5,
    isCorrect: true,
    fields: { author: { match: true }, dynasty: { match: true }, body: { match: true } },
    bodyDiff: [],
    reference: { author: '范仲淹', dynasty: '宋', body: '庆历四年春……' },
    feedback: null,
    feedbackPending: false,
    pointsAwarded: 0,
    ...overrides,
  };
}

function renderPage() {
  const router = createMemoryRouter(
    [{ path: '/', element: (
      <>
        <DictationRunPage />
        <PointsToast />
      </>
    ) }],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

/** 填完三个字段并提交（正文留空也能提交，但填上更接近真实流程）。 */
async function submitDictation() {
  renderPage();
  fireEvent.change(screen.getByPlaceholderText('例如：范仲淹'), { target: { value: '范仲淹' } });
  fireEvent.change(screen.getByPlaceholderText('例如：宋'), { target: { value: '宋' } });
  fireEvent.change(screen.getByPlaceholderText('默写整篇正文（标点与空格不计）'), {
    target: { value: '庆历四年春' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
  });
}

describe('DictationRunPage 发分反馈', () => {
  beforeEach(() => {
    judgeMock.mockReset();
    feedbackMock.mockReset();
    feedbackMock.mockResolvedValue({ feedback: '注意「谪」字' });
    sessionStorage.setItem('training:dictation', JSON.stringify([QUESTION]));
  });

  it('判题发分（pointsAwarded > 0）→ push 轻反馈，标题认出是默写', async () => {
    judgeMock.mockResolvedValue(judged({ pointsAwarded: 6 }));

    await submitDictation();

    expect(usePointsStore.getState().queue).toHaveLength(1);
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 6, title: '古诗文默写 · 一篇' });
    expect(screen.getByText('+6 分')).toBeTruthy();
  });

  it('0 分且无 reason（幂等命中，本次未入账）→ 静默，不 push 也不报错', async () => {
    judgeMock.mockResolvedValue(judged({ pointsAwarded: 0 }));

    await submitDictation();

    expect(usePointsStore.getState().queue).toHaveLength(0);
    expect(screen.getByText('全部正确')).toBeTruthy();
  });

  it('0 分 + daily_limit → 弹「今日该任务积分已达上限」', async () => {
    judgeMock.mockResolvedValue(judged({ pointsAwarded: 0, awardReason: 'daily_limit' }));

    await submitDictation();

    expect(usePointsStore.getState().queue).toHaveLength(1);
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 0, title: '古诗文默写 · 一篇' });
    expect(screen.getByText('今日该任务积分已达上限')).toBeTruthy();
  });

  it('0 分 + genre_unset（篇目未设体裁档）→ 静默，不弹假上限文案', async () => {
    judgeMock.mockResolvedValue(judged({ pointsAwarded: 0, awardReason: 'genre_unset' }));

    await submitDictation();

    expect(usePointsStore.getState().queue).toHaveLength(0);
    expect(screen.queryByText('今日该任务积分已达上限')).toBeNull();
  });
});
