import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import VariationRunPage from './VariationRunPage';
import { ApiError } from '@/services/api';

/**
 * 错题升级变式练习作答页（PRD §7.10，2026-10-11）。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 * 用 fill_blank（textbox + 「提交」按钮）驱动，不用 choice（选项按钮的可访问名依赖选项文本，脆弱）。
 *
 * 与 RemediationRunPage 的关键差异被钉住：
 * - 空 pending 静默回错题本（不弹「完成」toast——没生成过就没有）；
 * - q.n 是 variationId、提交接口用 questionId（两者经 data 反查映射）；
 * - 无积分反馈（本页不发分，纯加练）。
 */

const getTrainingVariations = vi.hoisted(() => vi.fn());
const submitVariationAnswer = vi.hoisted(() => vi.fn());
const selfAssessVariation = vi.hoisted(() => vi.fn());
const getTrainingHint = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getTrainingVariations, submitVariationAnswer, selfAssessVariation, getTrainingHint };
});
// toast 是模块级函数（Toast.tsx）：桩掉它才能断言「只弹一次」
vi.mock('@/components/base/Toast', () => ({ toast: toastMock }));

const PATH = '/student/training/variations/run';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  getTrainingVariations.mockReset();
  submitVariationAnswer.mockReset();
  selfAssessVariation.mockReset();
  getTrainingHint.mockReset();
  toastMock.mockReset();
});

/** RunExitGuard 用 useBlocker —— 必须是 data router（createMemoryRouter），且要传 initialEntries。 */
function renderPage(initialEntries: string[] = [PATH]) {
  const router = createMemoryRouter(
    [
      { path: PATH, element: <VariationRunPage /> },
      { path: '/student/training/errors', element: <div>错题本</div> },
    ],
    { initialEntries },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

const VAR_A = { variationId: 501, questionId: 88, errorBookId: 33, text: '变式一', type: 'fill_blank', options: null, difficulty: 1 };
const VAR_B = { variationId: 502, questionId: 89, errorBookId: 33, text: '变式二', type: 'fill_blank', options: null, difficulty: 1 };

describe('VariationRunPage', () => {
  it('加载并渲染 pending 变式（标题计数）', async () => {
    getTrainingVariations.mockResolvedValue({ variations: [VAR_A, VAR_B] });

    renderPage();

    expect(await screen.findByText('变式一')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /待练 2 题/ })).toBeInTheDocument();
  });

  it('空 pending 静默跳回错题本（不弹完成 toast）', async () => {
    getTrainingVariations.mockResolvedValue({ variations: [] });

    const { router } = renderPage();

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/errors'));
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('加载失败：toast + 回错题本', async () => {
    getTrainingVariations.mockRejectedValue(new Error('boom'));

    const { router } = renderPage();

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/errors'));
    expect(toastMock).toHaveBeenCalledWith('error', 'boom');
  });

  it('?errorBookId= 透传给接口（错题本条目入口）', async () => {
    getTrainingVariations.mockResolvedValue({ variations: [] });

    const { router } = renderPage([`${PATH}?errorBookId=33`]);

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/errors'));
    expect(getTrainingVariations).toHaveBeenCalledWith({ errorBookId: 33 });
  });

  it('query errorBookId 非法（abc / 0）按缺省处理：不带过滤拉全部', async () => {
    getTrainingVariations.mockResolvedValue({ variations: [] });

    renderPage([`${PATH}?errorBookId=abc`]);

    await waitFor(() => expect(getTrainingVariations).toHaveBeenCalledWith({ errorBookId: undefined }));
  });

  it('提交用 questionId（不是 variationId），答完末题重拉为空 → 弹完成并回错题本', async () => {
    const user = userEvent.setup();
    getTrainingVariations
      .mockResolvedValueOnce({ variations: [VAR_A] })
      // onFinish 的重拉：已全部落定
      .mockResolvedValueOnce({ variations: [] });
    submitVariationAnswer.mockResolvedValue({
      isCorrect: true,
      method: 'exact',
      errorType: null,
      needsSelfAssessment: false,
      referenceAnswer: null,
      explanation: null,
      remainingCount: 0,
    });

    const { router } = renderPage();
    await screen.findByText('变式一');
    await user.type(screen.getByRole('textbox'), '4');
    await user.click(screen.getByRole('button', { name: '提交' }));

    // 提交载荷是 questionId=88（variationId=501 只作 runner key）
    await waitFor(() =>
      expect(submitVariationAnswer).toHaveBeenCalledWith({ questionId: 88, studentAnswer: '4' }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/errors'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('success', '变式练习完成'));
    expect(toastMock.mock.calls.filter(([t]) => t === 'success')).toHaveLength(1);
    expect(getTrainingVariations).toHaveBeenCalledTimes(2);
  });

  it('finish 重拉仍有 pending → 换轮次重挂（并发生成的新变式）', async () => {
    const user = userEvent.setup();
    getTrainingVariations
      .mockResolvedValueOnce({ variations: [VAR_A] })
      .mockResolvedValueOnce({ variations: [{ ...VAR_B, text: '新变式' }] });
    submitVariationAnswer.mockResolvedValue({
      isCorrect: false,
      method: 'exact',
      errorType: null,
      needsSelfAssessment: false,
      referenceAnswer: null,
      explanation: null,
      remainingCount: 1,
    });

    renderPage();
    await screen.findByText('变式一');
    await user.type(screen.getByRole('textbox'), 'x');
    await user.click(screen.getByRole('button', { name: '提交' }));

    expect(await screen.findByText('新变式')).toBeInTheDocument();
    expect(getTrainingVariations).toHaveBeenCalledTimes(2);
  });

  it('主观题：needsSelfAssessment → 自评走 self-assess 端点（questionId 映射）', async () => {
    const user = userEvent.setup();
    getTrainingVariations.mockResolvedValue({
      variations: [{ ...VAR_A, type: 'short_answer', text: '说说你的理解' }],
    });
    submitVariationAnswer.mockResolvedValue({
      isCorrect: null,
      method: 'self_assess',
      errorType: null,
      needsSelfAssessment: true,
      referenceAnswer: '参考答案',
      explanation: null,
      remainingCount: 1,
    });
    selfAssessVariation.mockResolvedValue({
      isCorrect: true,
      method: 'self_assess',
      errorType: null,
      needsSelfAssessment: false,
      referenceAnswer: null,
      explanation: null,
      remainingCount: 0,
    });
    getTrainingVariations.mockResolvedValueOnce({ variations: [{ ...VAR_A, type: 'short_answer', text: '说说你的理解' }] });
    // 自评落定后 finish 重拉为空（第二次 load 调用）
    getTrainingVariations.mockResolvedValue({ variations: [] });

    const { router } = renderPage();
    await screen.findByText('说说你的理解');
    await user.type(screen.getByRole('textbox'), '我的答案');
    await user.click(screen.getByRole('button', { name: '提交' }));

    // 自评 UI 出现（参考答案经 markdown 渲染，文本断言不稳；钉自评按钮）
    await waitFor(() => expect(screen.getByRole('button', { name: '我做对了' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '我做对了' }));

    await waitFor(() =>
      expect(selfAssessVariation).toHaveBeenCalledWith({ questionId: 88, assessment: 'correct' }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/errors'));
  });

  it('提交被 4xx 拒绝：弹服务端原话，不说「检查网络」', async () => {
    const user = userEvent.setup();
    getTrainingVariations.mockResolvedValue({ variations: [VAR_A] });
    submitVariationAnswer.mockRejectedValue(new ApiError(1001, '该变式题不在待练清单或已作答', false, 400));

    renderPage();
    await screen.findByText('变式一');
    await user.type(screen.getByRole('textbox'), '4');
    await user.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('error', '该变式题不在待练清单或已作答'),
    );
    expect(toastMock).not.toHaveBeenCalledWith('error', '答案提交失败，请检查网络后重试');
  });

  it('提交网络失败（无 status）：提示「检查网络后重试」', async () => {
    const user = userEvent.setup();
    getTrainingVariations.mockResolvedValue({ variations: [VAR_A] });
    submitVariationAnswer.mockRejectedValue(new Error('network down'));

    renderPage();
    await screen.findByText('变式一');
    await user.type(screen.getByRole('textbox'), '4');
    await user.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('error', '答案提交失败，请检查网络后重试'),
    );
  });
});
