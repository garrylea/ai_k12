import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import ExamRunPage from './ExamRunPage';
import {
  getExamSession,
  submitExamAnswer,
  submitExamSession,
  type ExamSessionInfo,
  type ExamSummary,
} from '@/services/api';

/**
 * 考试进行页：把交卷响应里的 `points` 交棒给结果页（计划 §3 Task 7c 的授权改动）。
 *
 * 缺了这一步 7c 就没有数据来源：结果页用 `getExamResults`（GET）加载，**GET 不补发分**，
 * 所以「页面读交卷响应里的积分」必须在**交卷那一刻**接住，经 navigate state 带过去。
 * 这里钉住：
 *   - 有 points → 原样交给导航 state；
 *   - 响应没有 points（重复交卷等幂等分支）→ 整个不带导航 state（不是挂一个 `{ points: undefined }`）；
 *   - 进页时已是 submitted（刷新 / 续考）→ 那条分支不带 points。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 */
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getExamSession: vi.fn(), submitExamAnswer: vi.fn(), submitExamSession: vi.fn() };
});

const sessionMock = vi.mocked(getExamSession);
const answerMock = vi.mocked(submitExamAnswer);
const submitMock = vi.mocked(submitExamSession);

const SESSION: ExamSessionInfo = {
  sessionId: 77,
  status: 'in_progress',
  remainingSeconds: 600,
  questions: [{ questionId: 101, questionNo: 1, text: '1 + 1 = ?', type: 'choice', options: ['A. 1', 'B. 2'] }],
};

/** RunExitGuard 用 useBlocker —— 必须是 data router；结果页给个占位元素。 */
function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/student/training/exam/run/:sessionId', element: <ExamRunPage /> },
      { path: '/student/training/exam/result/:sessionId', element: <div>结果页占位</div> },
    ],
    { initialEntries: ['/student/training/exam/run/77'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** 答完唯一一题并交卷（末题答完即触发交卷）。 */
async function answerAndSubmit() {
  const router = renderPage();
  fireEvent.click(screen.getAllByRole('radio')[1]);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
  });
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/student/training/exam/result/77');
  });
  return router;
}

describe('ExamRunPage 交卷发分交接', () => {
  beforeEach(() => {
    sessionMock.mockReset();
    answerMock.mockReset();
    submitMock.mockReset();
    answerMock.mockResolvedValue({ saved: true });
    sessionMock.mockResolvedValue(SESSION);
    sessionStorage.setItem('exam:session', JSON.stringify(SESSION));
  });

  it('交卷响应带 points → 经 navigate state 交给结果页（不丢发分结果）', async () => {
    const points: NonNullable<ExamSummary['points']> = { awarded: 12, balance: 612, levelUp: null };
    submitMock.mockResolvedValue({ correctCount: 18, totalCount: 20, accuracy: 90, points });

    const router = await answerAndSubmit();

    expect(submitMock).toHaveBeenCalledWith(77);
    expect(router.state.location.state).toEqual({ points });
  });

  it('交卷响应没有 points（幂等 / 重复交卷）→ 完全不带导航 state，不留 `{ points: undefined }` 空壳', async () => {
    submitMock.mockResolvedValue({ correctCount: 18, totalCount: 20, accuracy: 90 });

    const router = await answerAndSubmit();

    // 不带 state → 结果页的 `location.state == null` 哨兵为真，不会白触发一次 replace
    expect(router.state.location.state).toBeNull();
  });

  it('进页时已是 submitted（刷新 / 续考）→ 那条分支不带 points', async () => {
    sessionStorage.setItem('exam:session', JSON.stringify({ ...SESSION, status: 'submitted' }));

    const router = renderPage();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/student/training/exam/result/77');
    });
    expect(router.state.location.state).toBeNull();
    // 这条分支根本没交卷，不该发第二个交卷请求
    expect(submitMock).not.toHaveBeenCalled();
  });
});
