import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import ErrorPracticeRunPage from './ErrorPracticeRunPage';
import {
  bumpTrainingErrorLevels,
  getTrainingExplanations,
  judgeTraining,
  type JudgeResult,
  type TrainingErrorBookEntry,
} from '@/services/api';
import { usePointsStore } from '@/store/pointsStore';
import { PointsToast } from '@/components/business/PointsToast';

/**
 * 错题重练答题页接发分反馈（计划 §3 Task 7c）。
 *
 * 本页是**甲类**：分数就在判题响应里（`pointsAwarded` / `awardReason`），
 * 它**不调** `completeTrainingSession`（没有会话），也不自己判断「什么时候弹什么」——
 * 一律交给共享决策模块 `usePointsFeedback`。这里钉住三件事：
 * 判题发分时 push 的参数正确、幂等命中（0 分无 reason）静默、
 * 已达上限（0 分 + `daily_limit`）弹中性文案而不是当错误。
 *
 * 轻反馈组件 `PointsToast` 一并挂上：它是全站唯一渲染队列的地方，
 * 只断言 store 会漏掉「文案其实没渲染出来」这类问题。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 */
afterEach(() => {
  cleanup();
  // store 是模块级单例，用例之间要清空队列，否则上一条的 toast 串到下一条
  usePointsStore.setState({ queue: [], revision: 0 });
  sessionStorage.clear();
});

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    judgeTraining: vi.fn(),
    bumpTrainingErrorLevels: vi.fn(),
    getTrainingExplanations: vi.fn(),
  };
});

const judgeMock = vi.mocked(judgeTraining);
const bumpMock = vi.mocked(bumpTrainingErrorLevels);
const explanationsMock = vi.mocked(getTrainingExplanations);

const ENTRY: TrainingErrorBookEntry = {
  errorBookId: 9001,
  questionId: 101,
  questionText: '1 + 1 = ?',
  type: 'choice',
  level: 1,
  createdAt: '2026-09-01',
  kpIds: [],
  options: ['A. 1', 'B. 2'],
};

/** 判题结果：本页只关心发分字段，其余给最小可用值。 */
function judged(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return { questionId: 101, isCorrect: true, method: 'exact', pointsAwarded: 0, ...overrides };
}

/** RunExitGuard 用 useBlocker —— 必须是 data router（createMemoryRouter）。
 *  第二条路由是结果页「确认」离开后的落点，用来断言导航真的发生了。 */
function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/', element: (
        <>
          <ErrorPracticeRunPage />
          <PointsToast />
        </>
      ) },
      { path: '/student/training/errors', element: <div>已回到错题列表</div> },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

/** 答完唯一一题（点选 B）并提交。 */
async function answerOnlyQuestion() {
  renderPage();
  fireEvent.click(screen.getAllByRole('radio')[1]);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
  });
}

describe('ErrorPracticeRunPage 发分反馈', () => {
  beforeEach(() => {
    judgeMock.mockReset();
    bumpMock.mockReset();
    explanationsMock.mockReset();
    bumpMock.mockResolvedValue(undefined);
    explanationsMock.mockResolvedValue({ explanations: {} });
    sessionStorage.setItem('training:errors', JSON.stringify([ENTRY]));
  });

  it('判题发分（pointsAwarded > 0）→ push 轻反馈，标题是「错题订正」', async () => {
    judgeMock.mockResolvedValue(judged({ pointsAwarded: 8 }));

    await answerOnlyQuestion();

    expect(judgeMock).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: 101, subjectId: 1, source: 'error_practice' }),
    );
    expect(usePointsStore.getState().queue).toHaveLength(1);
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 8, title: '错题订正' });
    expect(screen.getByText('+8 分')).toBeTruthy();
  });

  it('0 分且无 reason（幂等命中 / 没清掉错题）→ 静默，不 push 也不报错', async () => {
    judgeMock.mockResolvedValue(judged({ pointsAwarded: 0 }));

    await answerOnlyQuestion();

    expect(usePointsStore.getState().queue).toHaveLength(0);
    // 学习流程照走：结果页正常渲染
    expect(screen.getByText('答题结果')).toBeTruthy();
  });

  it('0 分 + daily_limit → 弹中性文案「今日该任务积分已达上限」，不是错误', async () => {
    judgeMock.mockResolvedValue(judged({ pointsAwarded: 0, awardReason: 'daily_limit' }));

    await answerOnlyQuestion();

    expect(usePointsStore.getState().queue).toHaveLength(1);
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 0, title: '错题订正' });
    expect(screen.getByText('今日该任务积分已达上限')).toBeTruthy();
  });

  /**
   * 会话结束后的守卫回归钉子（2026-09-22，与专项练习同批报障）：
   * 答完最后一题后点结果页「确认」= 正常结束、回错题列表，不得再弹
   * 「确认离开 / 继续答题」—— 守卫只保护「没答完就想走」。
   */
  it('答完最后一题后点结果页「确认」：直接离开，不弹退出守卫', async () => {
    judgeMock.mockResolvedValue(judged({ pointsAwarded: 8 }));

    await answerOnlyQuestion();
    await screen.findByText('答题结果');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认' }));
    });

    expect(screen.queryByRole('button', { name: '确认离开' })).toBeNull();
    expect(screen.queryByRole('button', { name: '继续答题' })).toBeNull();
    expect(await screen.findByText('已回到错题列表')).toBeTruthy();
  });
});
