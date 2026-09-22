import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import RemediationRunPage from './RemediationRunPage';
import { ApiError } from '@/services/api';

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
   * 一次 onFinish。修复后 `handleFinish` 靠顶部的 completedRef 早退把这次多余重拉整个拦下。
   * 两条断言各钉一个机制：
   *  - 「getRemediationQuestions 只调 1 次」钉 `handleFinish` 顶部的早退：单独去掉它即变红（1 → 2 次）。
   *  - 「只弹一次 success」是用户可见不变量，钉 `handleCompleted` 的幂等守卫。因早退已先挡住第二条
   *    完成路径，单独去掉该守卫不会变红，只有两处守卫同时去掉才会变 2 条 toast（已实测）。
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
    // 幂等不变量：两处 completedRef 守卫都在时只会有这一条 success
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

  /**
   * 本轮没全对：重拉 → 换轮次重挂 runner，只渲染仍未答对的题。
   *
   * 这是除「全对离场」外**最主要的正常路径**（答错一题就要再战一轮），此前没有用例覆盖。
   * 它钉三件事：① `handleFinish` 的 else 分支确实执行 setData + round+1；
   * ② 换轮次真的重挂并渲染新题单（`key={round}` 生效）；③ 头部计数在轮次边界刷新
   * （同轮内不刷新是已知的 F2 小问题，此处顺带把「边界会刷新」钉住）。
   */
  it('本轮答错 → 重拉后换轮次重挂，只渲染仍未答对的题', async () => {
    const user = userEvent.setup();
    getRemediationQuestions
      .mockResolvedValueOnce({
        questions: [
          { questionId: 11, text: '第一题', type: 'fill_blank', options: null },
          { questionId: 12, text: '第二题', type: 'fill_blank', options: null },
        ],
        itemCount: 2,
        correctCount: 0,
      })
      // onFinish 的重拉：第 1 题答错留在套题里，第 2 题已答对
      .mockResolvedValueOnce({
        questions: [{ questionId: 11, text: '第一题（重出）', type: 'fill_blank', options: null }],
        itemCount: 2,
        correctCount: 1,
      });
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

    renderPage();
    await screen.findByText('第一题');
    expect(screen.getByRole('heading', { name: /已答对 0\/2/ })).toBeInTheDocument();

    // 第 1 题 → 自动进第 2 题；第 2 题提交后触发 onFinish
    await user.type(screen.getByRole('textbox'), 'x');
    await user.click(screen.getByRole('button', { name: '提交' }));
    await screen.findByText('第二题');
    await user.type(screen.getByRole('textbox'), 'y');
    await user.click(screen.getByRole('button', { name: '提交' }));

    // 换轮次后只剩未答对的第 1 题；头部计数取到重拉后的 1/2
    expect(await screen.findByText('第一题（重出）')).toBeInTheDocument();
    expect(screen.queryByText('第二题')).toBeNull();
    expect(screen.getByRole('heading', { name: /已答对 1\/2/ })).toBeInTheDocument();
    expect(getRemediationQuestions).toHaveBeenCalledTimes(2);
  });

  /**
   * 提交失败的两条文案分支（此前 catch 无覆盖 —— T12-M2）。
   *
   * 4xx 是业务性拒绝（该题已答对 / 不在套题 / 已无进行中套题，如另一标签页刚清套），
   * 服务端 message 本身就是可照做的指引；网络失败没有 status，才该说「检查网络」。
   * 引错方向比不说更糟，故两条都要钉住。
   */
  it('提交被 4xx 拒绝：弹服务端原话，不说「检查网络」', async () => {
    const user = userEvent.setup();
    getRemediationQuestions.mockResolvedValue({
      questions: [{ questionId: 11, text: '唯一一题', type: 'fill_blank', options: null }],
      itemCount: 1,
      correctCount: 0,
    });
    submitRemediationAnswer.mockRejectedValue(
      new ApiError(1001, '该题已答对，无需重复作答', false, 400),
    );

    renderPage();
    await screen.findByText('唯一一题');
    await user.type(screen.getByRole('textbox'), '2');
    await user.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('error', '该题已答对，无需重复作答'),
    );
    expect(toastMock).not.toHaveBeenCalledWith('error', '答案提交失败，请检查网络后重试');
  });

  it('提交网络失败（无 status）：仍提示「检查网络后重试」', async () => {
    const user = userEvent.setup();
    getRemediationQuestions.mockResolvedValue({
      questions: [{ questionId: 11, text: '唯一一题', type: 'fill_blank', options: null }],
      itemCount: 1,
      correctCount: 0,
    });
    submitRemediationAnswer.mockRejectedValue(new Error('network down'));

    renderPage();
    await screen.findByText('唯一一题');
    await user.type(screen.getByRole('textbox'), '2');
    await user.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('error', '答案提交失败，请检查网络后重试'),
    );
  });
});
