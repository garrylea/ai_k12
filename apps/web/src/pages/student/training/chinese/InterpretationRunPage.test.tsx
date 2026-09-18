import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import InterpretationRunPage from './InterpretationRunPage';
import {
  judgeInterpretation,
  type InterpretationJudgeResult,
  type InterpretationPassageDetail,
} from '@/services/api';
import { usePointsStore } from '@/store/pointsStore';
import { PointsToast } from '@/components/business/PointsToast';

/**
 * 古诗文解释答题页接发分反馈（计划 §3 Task 7c）。
 *
 * 本页是**逐句判题**：只有整篇最后一句判完才发一次分，
 * **中间句恒为 `pointsAwarded: 0` 且不带 reason** —— 必须静默，
 * 否则会弹「今日该任务积分已达上限」的假文案（计划 §1.1#4）。
 * 所以这条「中间句静默、末句才反馈」的差别必须在真渲染里钉住。
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
  return { ...actual, judgeInterpretation: vi.fn() };
});

const judgeMock = vi.mocked(judgeInterpretation);

const PASSAGE: InterpretationPassageDetail = {
  passageId: 28,
  workTitle: '岳阳楼记',
  semester: '下册',
  sentences: [
    { index: 0, text: '庆历四年春', terms: [] },
    { index: 1, text: '滕子京谪守巴陵郡', terms: [] },
  ],
};

function judged(sentenceIndex: number, overrides: Partial<InterpretationJudgeResult> = {}): InterpretationJudgeResult {
  return {
    passageId: 28,
    sentenceIndex,
    allCorrect: false,
    terms: [],
    sentence: { correct: false, method: 'ai', standard: '标准译文', comment: null },
    fullTranslation: null,
    pointsAwarded: 0,
    ...overrides,
  };
}

function renderPage() {
  const router = createMemoryRouter(
    [{ path: '/', element: (
      <>
        <InterpretationRunPage />
        <PointsToast />
      </>
    ) }],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

describe('InterpretationRunPage 发分反馈', () => {
  beforeEach(() => {
    judgeMock.mockReset();
    sessionStorage.setItem('training:interpretation', JSON.stringify([PASSAGE]));
  });

  it('中间句 0 分无 reason → 静默；末句发分才 push（标题「古诗文翻译」）', async () => {
    judgeMock
      .mockResolvedValueOnce(judged(0, { pointsAwarded: 0 }))
      .mockResolvedValueOnce(judged(1, { pointsAwarded: 6, allCorrect: true, fullTranslation: '参考译文' }));

    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '下一句' }));
    });
    // 第 1 句是中间句：本次没发分，且没有 reason 可展示 → 一条都不许弹
    expect(judgeMock).toHaveBeenCalledTimes(1);
    expect(usePointsStore.getState().queue).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '完成本篇' }));
    });

    expect(judgeMock).toHaveBeenCalledTimes(2);
    expect(usePointsStore.getState().queue).toHaveLength(1);
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 6, title: '古诗文翻译' });
    expect(screen.getByText('+6 分')).toBeTruthy();
  });

  it('中间句 0 分 + daily_limit → 也弹「今日该任务积分已达上限」（证明中间句确实走了 award）', async () => {
    // 「中间句静默」有两条实现都能满足上面那条用例：走了 award 被静默、或压根只在末句 award。
    // daily_limit 是能区分的观察点：真走了 award 才可能在中途弹这条文案。
    judgeMock
      .mockResolvedValueOnce(judged(0, { pointsAwarded: 0, awardReason: 'daily_limit' }))
      .mockResolvedValueOnce(judged(1, { pointsAwarded: 0 }));

    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '下一句' }));
    });

    expect(judgeMock).toHaveBeenCalledTimes(1);
    expect(usePointsStore.getState().queue).toHaveLength(1);
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 0, title: '古诗文翻译' });
    expect(screen.getByText('今日该任务积分已达上限')).toBeTruthy();
  });

  it('末句 0 分 + daily_limit → 弹「今日该任务积分已达上限」', async () => {
    judgeMock
      .mockResolvedValueOnce(judged(0, { pointsAwarded: 0 }))
      .mockResolvedValueOnce(judged(1, { pointsAwarded: 0, awardReason: 'daily_limit' }));

    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '下一句' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '完成本篇' }));
    });

    expect(usePointsStore.getState().queue).toHaveLength(1);
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 0, title: '古诗文翻译' });
    expect(screen.getByText('今日该任务积分已达上限')).toBeTruthy();
  });
});
