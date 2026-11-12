import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import ExamRunPage from './ExamRunPage';
import { ParentUnlockContext } from '@/kiosk/parentUnlockContext';
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
  questions: [{ questionId: 101, questionNo: 1, text: '1 + 1 = ?', type: 'choice', options: ['A. 1', 'B. 2'], materialText: null }],
};

/** RunExitGuard 用 useBlocker —— 必须是 data router；结果页与列表页给占位元素。 */
function renderPage(unlockedByParent = false) {
  const router = createMemoryRouter(
    [
      {
        path: '/student/training/exam/run/:sessionId',
        element: (
          <ParentUnlockContext.Provider value={unlockedByParent}>
            <ExamRunPage />
          </ParentUnlockContext.Provider>
        ),
      },
      { path: '/student/training/exam', element: <div>考试列表占位</div> },
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

  it('题号用原始 questionNo：前序题被 is_active=0 隐藏时，不把题3显示成"第1题"', async () => {
    // 模拟题1/题2 被 needs_review 过滤，只剩题3（顺序第 1 位）
    const gapSession: ExamSessionInfo = {
      ...SESSION,
      questions: [{ questionId: 103, questionNo: 3, text: '题三', type: 'choice', options: ['A. 1', 'B. 2'], materialText: null }],
    };
    sessionMock.mockResolvedValue(gapSession);
    sessionStorage.setItem('exam:session', JSON.stringify(gapSession));

    renderPage();

    // 必须显示"第 3 题"（卷内题号），而不是顺序位的"第 1/1 题"
    await waitFor(() => expect(screen.getByText('第 3 题')).toBeTruthy());
    expect(screen.queryByText('第 1/1 题')).toBeNull();
  });
});

describe('ExamRunPage 家长解锁后的返回入口（spec 2026-11-12）', () => {
  beforeEach(() => {
    sessionMock.mockReset();
    answerMock.mockReset();
    submitMock.mockReset();
    answerMock.mockResolvedValue({ saved: true });
    sessionMock.mockResolvedValue(SESSION);
    sessionStorage.setItem('exam:session', JSON.stringify(SESSION));
  });

  it('家长未解锁 → 不渲染返回入口', async () => {
    renderPage(false);
    await waitFor(() => expect(screen.getByText('第 1 题')).toBeInTheDocument());

    expect(screen.queryByLabelText('返回考试列表')).toBeNull();
  });

  it('家长已解锁 → 出现返回入口；点击弹「离开考试」确认，确认后回到考试列表', async () => {
    const router = renderPage(true);
    await waitFor(() => expect(screen.getByLabelText('返回考试列表')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('返回考试列表'));

    // 必须仍然被 RunExitGuard 拦住（不能绕过确认直接走）
    await waitFor(() => expect(screen.getByText('离开考试')).toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/student/training/exam/run/77');

    fireEvent.click(screen.getByRole('button', { name: '确认离开' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/exam'));
    // 落点是考试列表，并带上当前学科（默认数学 = 1）
    expect(router.state.location.search).toBe('?subjectId=1');
  });
});
