import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from '@/routes/routeTable';
import { getParentDashboard, getUnreadMessageCount, listMyStudents, type MyStudentItem, type ParentDashboard } from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { useThemeStore } from '@/store/themeStore';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listMyStudents: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getParentDashboard: vi.fn(),
  };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMock = vi.mocked(getUnreadMessageCount);
const getDashboardMock = vi.mocked(getParentDashboard);

const BOY: MyStudentItem = { id: 11, parentId: 3, username: 'xiaoming', name: '小明', age: 13, grade: '初一', schoolLevel: 'junior', isActive: true };
const GIRL: MyStudentItem = { ...BOY, id: 12, username: 'xiaomei', name: '小美' };

const DASHBOARD: ParentDashboard = {
  unreadAlerts: 0,
  students: [
    {
      studentId: 11, name: '小明', grade: '初一', schoolLevel: 'junior',
      lastActiveAt: '2026-09-18T20:11:00.000Z', activeDays7: 3, unreadAlerts: 0,
      subjects: [
        {
          subjectId: 1, subjectName: '数学',
          progress: {
            completedUnits: 2, totalUnits: 8,
            currentUnitName: '第二章 整式的加减', currentLessonName: '2.1 整式', percent: 25,
          },
          accuracy: { answered: 42, correct: 31, rate: 73.8 },
          selfAssessed: { count: 5, correctCount: 3 },
          errorBook: { uncleared: 12, total: 20 },
          examCount: 4,
        },
      ],
    },
    {
      studentId: 12, name: '小美', grade: '初一', schoolLevel: 'junior',
      lastActiveAt: null, activeDays7: 0, unreadAlerts: 0,
      subjects: [
        {
          subjectId: 1, subjectName: '数学',
          progress: { completedUnits: 0, totalUnits: 8, currentUnitName: null, currentLessonName: null, percent: 0 },
          // 没做过题：rate 必须是 null，UI 应显示「暂无数据」而不是 0%
          accuracy: { answered: 0, correct: 0, rate: null },
          selfAssessed: { count: 0, correctCount: 0 },
          errorBook: { uncleared: 0, total: 0 },
          examCount: 0,
        },
      ],
    },
  ],
};

function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

function renderAt(path: string) {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'parent');
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const result = render(<RouterProvider router={router} />);
  return { router, ...result };
}

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: null });
  listMyStudentsMock.mockReset();
  listMyStudentsMock.mockResolvedValue([BOY, GIRL]);
  getUnreadMock.mockReset();
  getUnreadMock.mockResolvedValue(0);
  getDashboardMock.mockReset();
  getDashboardMock.mockResolvedValue(DASHBOARD);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  useThemeStore.setState({ mode: 'student-day' });
});

describe('ParentDashboardPage', () => {
  it('渲染首个孩子的学科卡片（进度 / 正确率 / 错题 / 考试 / 活跃天数）', async () => {
    renderAt('/parent/dashboard');

    const panel = await screen.findByTestId('dashboard-student-11');
    expect(panel).toHaveTextContent('数学');
    expect(panel).toHaveTextContent('2 / 8');
    expect(panel).toHaveTextContent('第二章 整式的加减');
    expect(panel).toHaveTextContent('2.1 整式');
    expect(panel).toHaveTextContent('73.8%');
    expect(panel).toHaveTextContent('12');
    expect(panel).toHaveTextContent('4');
    expect(panel).toHaveTextContent('3');
  });

  it('rate 为 null → 显示「暂无数据」，不显示 0%', async () => {
    renderAt('/parent/dashboard');
    await screen.findByTestId('dashboard-student-11');

    fireEvent.click(screen.getByRole('tab', { name: '小美' }));

    const panel = await screen.findByTestId('dashboard-student-12');
    expect(panel).toHaveTextContent('暂无数据');
    expect(panel).not.toHaveTextContent('0%');
  });

  it('多孩 → 出孩子 Tab；点 Tab 只在本地切换，**不动锚点**', async () => {
    renderAt('/parent/dashboard');
    await screen.findByTestId('dashboard-student-11');

    fireEvent.click(screen.getByRole('tab', { name: '小美' }));

    await screen.findByTestId('dashboard-student-12');
    // 顶栏 StudentSwitcher 挂载时会把锚点落到第一个孩子（11）；
    // 点 Tab 只切本地展示，**不能**把它改成 12 —— 否则一次点击就改了「当前查看的孩子」，
    // 报告/错题/回放三页会跟着跳走。
    expect(useParentStudentStore.getState().studentId).toBe(11);
  });

  it('快捷入口先设锚点再导航（否则报告页会跟错孩子）', async () => {
    const { router } = renderAt('/parent/dashboard');
    await screen.findByTestId('dashboard-student-11');

    fireEvent.click(screen.getByRole('tab', { name: '小美' }));
    const panel = await screen.findByTestId('dashboard-student-12');
    fireEvent.click(within(panel).getByRole('button', { name: '学情报告' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/parent/report'));
    expect(useParentStudentStore.getState().studentId).toBe(12);
  });

  it('名下没有孩子 → 空态 + 去创建账号的入口', async () => {
    listMyStudentsMock.mockResolvedValue([]);
    getDashboardMock.mockResolvedValue({ students: [], unreadAlerts: 0 });

    renderAt('/parent/dashboard');

    const empty = await screen.findByTestId('dashboard-empty');
    // 必须**限定在空态容器内**查：没有孩子时顶栏 `StudentSwitcher` 也会渲染一个
    // 「去创建学生账号」链接，不加限定的 getByRole 会同时命中两个而抛错。
    expect(within(empty).getByRole('link', { name: /创建学生账号/ })).toBeInTheDocument();
  });

  it('加载中 → 骨架，不到货不渲染卡片', async () => {
    getDashboardMock.mockImplementation(() => new Promise(() => {}));

    renderAt('/parent/dashboard');

    expect(await screen.findByTestId('dashboard-skeleton')).toBeInTheDocument();
  });

  it('接口报错 → 错误条 + 重试可重新拉取', async () => {
    getDashboardMock.mockRejectedValueOnce(new Error('boom'));

    renderAt('/parent/dashboard');

    const errBox = await screen.findByTestId('dashboard-error');
    getDashboardMock.mockResolvedValue(DASHBOARD);
    fireEvent.click(within(errBox).getByRole('button', { name: '重试' }));

    expect(await screen.findByTestId('dashboard-student-11')).toBeInTheDocument();
  });
});
