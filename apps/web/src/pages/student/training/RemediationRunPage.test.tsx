import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import RemediationRunPage from './RemediationRunPage';

/**
 * 相似题专项（错题补偿套题）作答页。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 * 用 fill_blank（textbox + 「提交」按钮）驱动，不用 choice（选项按钮的可访问名依赖选项文本，脆弱）。
 */

const getRemediationQuestions = vi.hoisted(() => vi.fn());
const submitRemediationAnswer = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getRemediationQuestions, submitRemediationAnswer };
});
// toast 是模块级函数（Toast.tsx）：桩掉它才能断言「只弹一次」
vi.mock('@/components/base/Toast', () => ({ toast: toastMock }));

const PATH = '/student/training/remediation/run';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  getRemediationQuestions.mockReset();
  submitRemediationAnswer.mockReset();
  toastMock.mockReset();
});

/** RunExitGuard 用 useBlocker —— 必须是 data router（createMemoryRouter），且要传 initialEntries。 */
function renderPage() {
  const router = createMemoryRouter(
    [
      { path: PATH, element: <RemediationRunPage /> },
      { path: '/student/training/home', element: <div>训练首页</div> },
    ],
    // 缺 initialEntries 时默认入口是 '/'，路由表里没有 '/' → 什么都不渲染、findByText 必然超时
    { initialEntries: [PATH] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

describe('RemediationRunPage', () => {
  it('加载并渲染套题题目', async () => {
    getRemediationQuestions.mockResolvedValue({
      questions: [{ questionId: 11, text: '1+1=?', type: 'fill_blank', options: null }],
      itemCount: 1,
      correctCount: 0,
    });

    renderPage();

    expect(await screen.findByText('1+1=?')).toBeInTheDocument();
  });

  it('空套题跳回训练首页', async () => {
    getRemediationQuestions.mockResolvedValue({ questions: [], itemCount: 0, correctCount: 0 });

    const { router } = renderPage();

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/home'));
  });

  /**
   * 幂等钉子：末题答对时，「submit 返回 setCompleted」与「onFinish 重拉发现空」
   * 会各触发一次完成处理——必须只弹一条 toast。删掉 completedRef 守卫这条用例会红。
   */
  it('末题答对：完成处理幂等，只弹一次「已清零」', async () => {
    const user = userEvent.setup();
    getRemediationQuestions
      .mockResolvedValueOnce({
        questions: [{ questionId: 11, text: '唯一一题', type: 'fill_blank', options: null }],
        itemCount: 1,
        correctCount: 0,
      })
      // onFinish 的重拉：套题已被后端清掉 → 空
      .mockResolvedValue({ questions: [], itemCount: 1, correctCount: 1 });
    submitRemediationAnswer.mockResolvedValue({
      isCorrect: true,
      method: 'exact',
      errorType: null,
      needsSelfAssessment: false,
      referenceAnswer: null,
      explanation: null,
      points: { pointsAwarded: 4, balance: 104, totalEarned: 504, levelUp: null },
      setCompleted: true,
      remainingCount: 0,
    });

    const { router } = renderPage();
    await screen.findByText('唯一一题');
    await user.type(screen.getByRole('textbox'), '2');
    await user.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/home'));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('success', '套题全部答对，已清零'),
    );
    // 幂等钉子：删掉 completedRef 会变 2
    expect(toastMock.mock.calls.filter(([t]) => t === 'success')).toHaveLength(1);
  });
});
