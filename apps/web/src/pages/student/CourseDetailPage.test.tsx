import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import CourseDetailPage from './CourseDetailPage';
import {
  fetchLessonCards,
  getMyPoints,
  getUnclearedErrors,
  updateProgress,
  type LessonCard,
} from '@/services/api';
import { usePointsStore } from '@/store/pointsStore';
import { useThemeStore } from '@/store/themeStore';

/**
 * 主线完成态回归（计划 §3 Task 3 点名的审查重点）。
 *
 * 为什么必须有这组用例：庆祝层从页面内联抽成 `CelebrationOverlay` 公共组件后，
 * 类型检查抓不到「运行时数据形状」的问题（参照 `SentenceBlock.test.tsx` 那次 React #31）。
 * 这里渲染真页面，驱动到「完成」按钮，钉住：
 *   1. 完成态仍弹全屏庆祝（`role="dialog"`）且标题按 `completed` 分支正确；
 *   2. 主按钮回调仍走到 `handleStartNewLesson`（导航发生）；
 *   3. `points` 接到后按规则发轻反馈 / 升级走全屏、不重复弹；
 *   4. 后端 `practice_incomplete` 门禁仍然拦住完成。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    fetchLessonCards: vi.fn(),
    getUnclearedErrors: vi.fn(),
    updateProgress: vi.fn(),
    getMyPoints: vi.fn(),
  };
});

const fetchLessonCardsMock = vi.mocked(fetchLessonCards);
const getUnclearedErrorsMock = vi.mocked(getUnclearedErrors);
const updateProgressMock = vi.mocked(updateProgress);
const getMyPointsMock = vi.mocked(getMyPoints);

const CARD: LessonCard = {
  id: 11,
  sortOrder: 1,
  cardType: 'concept',
  title: '概念',
  content: '一节的内容',
  metadata: null,
  textbookPage: null,
};

/** 只给一张卡：首页即末页，「完成」按钮直接可见。 */
function renderCourseDetail() {
  const router = createMemoryRouter(
    [
      { path: '/student/course-detail', element: <CourseDetailPage /> },
      { path: '/student/star-map', element: <div>星图页</div> },
    ],
    {
      initialEntries: [
        {
          pathname: '/student/course-detail',
          state: { lessonId: 7, subjectId: 3, subjectName: '数学', gradeName: '九年级上' },
        },
      ],
    },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** 渲染 → 等加载完 → 点「完成」。 */
async function finishLesson() {
  const router = renderCourseDetail();
  fireEvent.click(await screen.findByRole('button', { name: '完成' }));
  return router;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  usePointsStore.setState({ queue: [] });
  useThemeStore.setState({ motionEnabled: true });
});

beforeEach(() => {
  // localStorage / Request 两处环境坑已统一在 `src/test/setup.ts`（全局 beforeEach）处理。

  // jsdom 没有 canvas 实现：stub 掉避免 not-implemented 噪音（烟花本身另有单测）
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    setTransform: vi.fn(),
    globalAlpha: 1,
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D);

  usePointsStore.setState({ queue: [] });
  useThemeStore.setState({ motionEnabled: true });

  fetchLessonCardsMock.mockResolvedValue({
    lessonId: 7,
    lessonName: '有理数',
    totalCards: 1,
    cards: [CARD],
  });
  getUnclearedErrorsMock.mockResolvedValue({ errors: [] });
  updateProgressMock.mockResolvedValue({ advanced: true, nextLessonId: 42 });
  getMyPointsMock.mockRejectedValue(new Error('不该被调用'));
});

describe('CourseDetailPage 完成态庆祝', () => {
  it('学完本节 → 弹全屏庆祝「本节学习完成！」，主按钮为「开始新课」', async () => {
    updateProgressMock.mockResolvedValue({
      advanced: true,
      nextLessonId: 42,
      points: { awarded: 10, balance: 110, levelUp: null },
    });

    await finishLesson();

    expect(await screen.findByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: '恭喜你，本节学习完成！' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始新课' })).toBeInTheDocument();
    // 倒计时文案是通用的，目的地必须由页面 subtitle 交代（「N 秒后自动继续」的所指）
    expect(screen.getByText(/即将进入下一课/)).toBeInTheDocument();
  });

  it('点主按钮「开始新课」→ 带着下一课 id 跳课程详情', async () => {
    updateProgressMock.mockResolvedValue({
      advanced: true,
      nextLessonId: 42,
      points: { awarded: 10, balance: 110, levelUp: null },
    });

    const router = await finishLesson();
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: '开始新课' }));

    await waitFor(() =>
      expect(router.state.location.state).toMatchObject({ lessonId: 42, subjectId: 3 }),
    );
  });

  it('awarded > 0 → 同时发右下角轻反馈（+10 分）', async () => {
    updateProgressMock.mockResolvedValue({
      advanced: true,
      nextLessonId: 42,
      points: { awarded: 10, balance: 110, levelUp: null },
    });

    await finishLesson();
    await screen.findByRole('dialog');

    expect(usePointsStore.getState().queue).toHaveLength(1);
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 10 });
  });

  it('awarded === 0（幂等命中）→ 静默，不发「已达上限」假文案的轻反馈', async () => {
    updateProgressMock.mockResolvedValue({
      advanced: true,
      nextLessonId: 42,
      points: { awarded: 0, balance: 110, levelUp: null },
    });

    await finishLesson();
    await screen.findByRole('dialog');

    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('整学科完成（completed: true）→ 换文案与主按钮，点主按钮回星图', async () => {
    updateProgressMock.mockResolvedValue({
      advanced: true,
      completed: true,
      points: { awarded: 10, balance: 110, levelUp: null },
    });

    const router = await finishLesson();

    expect(await screen.findByRole('heading', { name: '恭喜你，本学科全部完成！' })).toBeInTheDocument();
    expect(screen.getByText(/即将返回星图/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回星图' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/star-map'));
    expect(screen.getByText('星图页')).toBeInTheDocument();
  });

  it('levelUp 非空 → 用后端段位名弹晋升庆祝，且不发轻反馈（避免两处同弹）', async () => {
    updateProgressMock.mockResolvedValue({
      advanced: true,
      nextLessonId: 42,
      points: { awarded: 20, balance: 520, levelUp: { from: 'pichai', to: 'zhutie' } },
    });
    getMyPointsMock.mockResolvedValue({
      balance: 520,
      totalEarned: 520,
      todayEarned: 20,
      level: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
      nextLevel: { code: 'qingtong', name: '青铜', index: 2, threshold: 1500 },
      pointsToNextLevel: 980,
      progressPercent: 13,
    });

    await finishLesson();

    expect(await screen.findByRole('heading', { name: '晋升 铸铁！' })).toBeInTheDocument();
    expect(screen.getByTestId('celebration-level-icon')).toBeInTheDocument();
    expect(getMyPointsMock).toHaveBeenCalled();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('含 levelUp 时 getMyPoints 失败 → 降级为「晋升新段位！」且仍显示段位图标', async () => {
    updateProgressMock.mockResolvedValue({
      advanced: true,
      nextLessonId: 42,
      points: { awarded: 20, balance: 520, levelUp: { from: 'pichai', to: 'zhutie' } },
    });
    getMyPointsMock.mockRejectedValue(new Error('network down'));

    await finishLesson();

    expect(await screen.findByRole('heading', { name: '晋升新段位！' })).toBeInTheDocument();
    expect(screen.getByTestId('celebration-level-icon')).toBeInTheDocument();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('levelUp 与整学科完成同时发生 → 仍交代「本学科全部完成」，主按钮回星图', async () => {
    updateProgressMock.mockResolvedValue({
      advanced: true,
      completed: true,
      points: { awarded: 20, balance: 520, levelUp: { from: 'pichai', to: 'zhutie' } },
    });
    getMyPointsMock.mockResolvedValue({
      balance: 520,
      totalEarned: 520,
      todayEarned: 20,
      level: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
      nextLevel: { code: 'qingtong', name: '青铜', index: 2, threshold: 1500 },
      pointsToNextLevel: 980,
      progressPercent: 13,
    });

    const router = await finishLesson();

    // 标题走晋升分支，但学科完成的信息不能被盖掉；目的地仍是星图
    expect(await screen.findByRole('heading', { name: '晋升 铸铁！' })).toBeInTheDocument();
    expect(screen.getByText(/本学科全部完成/)).toBeInTheDocument();
    expect(screen.getByText(/即将返回星图/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回星图' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/star-map'));
  });

  it('侧栏用户区渲染为段位入口 UserBadge（保留「专注学习中...」副标题，退出仍在右侧）', async () => {
    localStorage.setItem('username', '小明');
    getMyPointsMock.mockResolvedValue({
      balance: 120,
      totalEarned: 520,
      todayEarned: 10,
      level: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
      nextLevel: { code: 'qingtong', name: '青铜', index: 2, threshold: 1500 },
      pointsToNextLevel: 980,
      progressPercent: 13,
    });

    renderCourseDetail();

    expect(await screen.findByTestId('user-badge')).toBeInTheDocument();
    expect(screen.getByText('小明')).toBeInTheDocument();
    expect(screen.getByText('专注学习中...')).toBeInTheDocument();
    expect(await screen.findByTestId('user-badge-level-icon')).toBeInTheDocument();
    // 退出仍是独立的图标按钮，不再挂在用户名药丸上
    expect(screen.getByLabelText('退出登录')).toBeInTheDocument();
  });

  it('后端兜底 practice_incomplete → 不弹庆祝，仍显示门禁提示', async () => {
    updateProgressMock.mockResolvedValue({ advanced: false, reason: 'practice_incomplete' });

    await finishLesson();

    expect(await screen.findByText('本课练习未完成，无法结束课程')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /恭喜你/ })).not.toBeInTheDocument();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });
});
