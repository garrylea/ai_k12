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
   * 末题答对：完成处理幂等，且收尾不再多发一次拉题。
   *
   * 末题答对时「submit 返回 setCompleted」先触发完成并 navigate 离开；runner 之后仍会再触发
   * 一次 onFinish，`handleFinish` 靠 completedRef 早退把它拦下 —— 所以收尾那次重拉根本不会发出。
   * 两条断言各钉一个机制（分别对应源码里两处 completedRef 用法）：
   *  - 「只弹一次 success」= `handleCompleted` 内的幂等守卫（去掉它完成处理会跑两次 → 2 条 toast）；
   *  - 「getRemediationQuestions 只调 1 次」= `handleFinish` 顶部的 completedRef 早退
   *    （去掉它，onFinish 会真的再拉一次 → 变 2 次；那条多出来的请求若失败还会把学生拖进判题死态）。
   */
  it('末题答对：完成处理幂等、收尾不再重拉，只弹一次「已清零」', async () => {
    const user = userEvent.setup();
    getRemediationQuestions
      .mockResolvedValueOnce({
        questions: [{ questionId: 11, text: '唯一一题', type: 'fill_blank', options: null }],
        itemCount: 1,
        correctCount: 0,
      })
      // 兜底（修复后收尾这次重拉不会发出，见下）：仍给第二个返回值 resolve 空，
      // 这样万一「早退」被去掉，第二条断言能干净地变红，而不是被 rejection 掩成失败路径
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
    // 幂等钉子：去掉 handleCompleted 的 completedRef 守卫会变 2
    expect(toastMock.mock.calls.filter(([t]) => t === 'success')).toHaveLength(1);
    // 早退钉子：去掉 handleFinish 顶部的 completedRef 早退，收尾那次重拉会真的发出 → 变 2
    expect(getRemediationQuestions).toHaveBeenCalledTimes(1);
  });

  /**
   * 收尾重拉失败：不能卡死在「判题中，请稍候…」。
   *
   * 末题答完但没全对（setCompleted=false）→ runner 触发 onFinish → 重拉待答项失败。
   * 旧实现 handleFinish 无 try/catch：请求一 reject，学生就永远停在 runner 的判题态
   * （那里只有 spinner，没有 X、没有重试），还会抛一个 unhandled rejection。
   * 现在应弹一条 error 提示并回训练首页（题目与进度都在服务端，重进即续做）。
   */
  it('收尾重拉失败：弹 error 并回训练首页，不卡在判题中', async () => {
    const user = userEvent.setup();
    getRemediationQuestions
      .mockResolvedValueOnce({
        questions: [{ questionId: 11, text: '唯一一题', type: 'fill_blank', options: null }],
        itemCount: 2,
        correctCount: 0,
      })
      // onFinish 的重拉：网络失败
      .mockRejectedValueOnce(new Error('network down'));
    submitRemediationAnswer.mockResolvedValue({
      isCorrect: false,
      method: 'exact',
      errorType: null,
      needsSelfAssessment: false,
      referenceAnswer: null,
      explanation: null,
      points: null,
      setCompleted: false,
      remainingCount: 1,
    });

    const { router } = renderPage();
    await screen.findByText('唯一一题');
    await user.type(screen.getByRole('textbox'), '9');
    await user.click(screen.getByRole('button', { name: '提交' }));

    // 没有卡在判题态：给提示 + 回首页
    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/home'));
    expect(toastMock).toHaveBeenCalledWith(
      'error',
      '网络不太稳定，请回训练首页重新进入相似题专项',
    );
    expect(screen.queryByText('判题中，请稍候…')).toBeNull();
  });
});
