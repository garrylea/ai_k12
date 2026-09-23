import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import TrainingHomePage from './TrainingHomePage';
import type { RemediationOverview } from '@/services/api';

/**
 * 训练三卡页顶部「待完成相似题专项练习」提示条（Task 11）。
 *
 * 钉住四件事：有未完成套题才出现、文案按 (总题数 - 已答对) 算、点「开始练习」
 * 进作答页、点 × 关闭后不再出现；外加一条兜底守卫——套题 active 但
 * itemCount - correctCount === 0 时**不得**渲染「待完成 0 题 / N 组」的荒谬文案。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 */

const getRemediationOverview = vi.hoisted(() => vi.fn());
const getTrainingErrorBook = vi.hoisted(() => vi.fn());

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getRemediationOverview, getTrainingErrorBook };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  getRemediationOverview.mockReset();
  getTrainingErrorBook.mockReset();
  getTrainingErrorBook.mockResolvedValue([]);
});

function overview(partial: Partial<RemediationOverview> = {}): RemediationOverview {
  return { active: true, setId: 5, groupCount: 2, itemCount: 6, correctCount: 1, ...partial };
}

/**
 * 作答页路由由后续任务注册，本页只负责跳转；测试里给目标路径挂一个桩，
 * 免得 memory router 报「No routes matched location」。
 * `initialEntries` 必需：memory router 默认落在 `/`，不指定就渲染 404 而非本页。
 */
function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/student/training/home', element: <TrainingHomePage /> },
      { path: '/student/training/remediation/run', element: <div>作答页桩</div> },
      { path: '/student/training/weak-points', element: <div>薄弱点图谱页桩</div> },
    ],
    { initialEntries: ['/student/training/home'] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

/** 等 effect 落地：三卡渲染 + overview 请求已发出。 */
async function renderSettled() {
  const utils = renderPage();
  expect(await screen.findByText('专项练习')).toBeInTheDocument();
  await waitFor(() => expect(getRemediationOverview).toHaveBeenCalled());
  await act(async () => {});
  return utils;
}

describe('TrainingHomePage 相似题专项练习提示条', () => {
  it('有未完成套题时显示提示条，题数按 itemCount - correctCount 计', async () => {
    getRemediationOverview.mockResolvedValue(overview());

    await renderSettled();

    expect(screen.getByText('相似题专项练习待完成：5 题 / 2 组')).toBeInTheDocument();
  });

  it('点击「开始练习」跳转到 /student/training/remediation/run', async () => {
    getRemediationOverview.mockResolvedValue(overview());

    const { router } = await renderSettled();

    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/student/training/remediation/run'),
    );
  });

  it('点关闭后提示条消失', async () => {
    getRemediationOverview.mockResolvedValue(overview());

    await renderSettled();
    expect(screen.getByText('相似题专项练习待完成：5 题 / 2 组')).toBeInTheDocument();

    fireEvent.click(screen.getByText('×'));

    await waitFor(() =>
      expect(screen.queryByText(/相似题专项练习待完成/)).toBeNull(),
    );
  });

  it('守卫：套题 active 但已全部答对（差值 0）时不渲染提示条', async () => {
    getRemediationOverview.mockResolvedValue(
      overview({ itemCount: 6, correctCount: 6 }),
    );

    await renderSettled();

    expect(screen.queryByText(/相似题专项练习待完成/)).toBeNull();
  });

  it('守卫：active 为 false 时不渲染提示条', async () => {
    getRemediationOverview.mockResolvedValue(overview({ active: false }));

    await renderSettled();

    expect(screen.queryByText(/相似题专项练习待完成/)).toBeNull();
  });

  it('overview 拉取失败：静默，三卡照常可点', async () => {
    getRemediationOverview.mockRejectedValue(new Error('boom'));

    await renderSettled();

    expect(screen.queryByText(/相似题专项练习待完成/)).toBeNull();
    expect(screen.getByText('专项练习')).toBeInTheDocument();
    expect(screen.getByText('真题考试')).toBeInTheDocument();
    expect(screen.getByText('错题练习')).toBeInTheDocument();
  });
});

describe('TrainingHomePage 薄弱点图谱入口（第 4 张卡）', () => {
  it('渲染第 4 张卡「薄弱点图谱」', async () => {
    getRemediationOverview.mockResolvedValue({ active: false, setId: 0, groupCount: 0, itemCount: 0, correctCount: 0 });

    await renderSettled();

    expect(screen.getByText('薄弱点图谱')).toBeInTheDocument();
  });

  it('点第 4 张卡跳 /student/training/weak-points', async () => {
    getRemediationOverview.mockResolvedValue({ active: false, setId: 0, groupCount: 0, itemCount: 0, correctCount: 0 });

    const { router } = await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: '进入薄弱点图谱' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/weak-points'));
  });
});
