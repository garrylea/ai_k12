import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from '@/routes/routeTable';
import {
  getParentPointRules,
  getParentPoints,
  getUnreadMessageCount,
  listMyStudents,
  type MyStudentItem,
  type MyPoints,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { useThemeStore } from '@/store/themeStore';

/**
 * Task 9：学生账号卡的「积分与奖励」入口。
 *
 * 钉两件事，都不是「mock 被调了」能替代的：
 *
 * 1. **真实导航**。挂的是 `routeTable.tsx` 导出的真实路由表（`createMemoryRouter(routes)`），
 *    点按钮后断言 `router.state.location.pathname` 真的变成 `/parent/rewards`、
 *    `/parent/students` 的页面已卸载——不是断言某个 navigate mock 收到过参数。
 * 2. **锚点先落到这张卡的孩子**。`/parent/rewards` 是按 `parentStudentStore.studentId`
 *    取数的：锚点若没设对，页面会请求、显示上一个孩子（跨学生显示是事故）。
 *    这里断言 `getParentPoints` **只以被点那个孩子的 id 调过一次**。
 *
 * 顺带钉住「没把原来的三个操作挤掉」——家长端 ≥1024 主断点、<1024 单列堆叠，
 * 布局由既有 class 负责，本用例只保证三个按钮与标签都还在。
 *
 * 鉴权按真实口径 stub（localStorage 的 token/userRole），**不放宽 `RequireRole`**。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listMyStudents: vi.fn(),
    createStudent: vi.fn(),
    resetStudentPassword: vi.fn(),
    setStudentStatus: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    // 导航到 /parent/rewards 后由 ParentPointsPage 调用
    getParentPoints: vi.fn(),
    getParentPointRules: vi.fn(),
  };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMessageCountMock = vi.mocked(getUnreadMessageCount);
const getParentPointsMock = vi.mocked(getParentPoints);
const getParentPointRulesMock = vi.mocked(getParentPointRules);

const BOY: MyStudentItem = {
  id: 11,
  parentId: 1,
  username: 'xiaoming',
  name: '小明',
  age: 9,
  grade: '三年级',
  schoolLevel: 'primary',
  isActive: true,
};

const GIRL: MyStudentItem = {
  id: 12,
  parentId: 1,
  username: 'xiaomei',
  name: '小美',
  age: 12,
  grade: '初一',
  schoolLevel: 'junior',
  isActive: true,
};

const POINTS: MyPoints = {
  balance: 120,
  totalEarned: 520,
  todayEarned: 10,
  level: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
  nextLevel: { code: 'qingtong', name: '青铜', index: 2, threshold: 1200 },
  pointsToNextLevel: 680,
  progressPercent: 2,
};

/** 造一个 exp 在未来的假 JWT：`isSessionValid()` 解 payload 校 exp，不是只看字符串存在。 */
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

/** 某个孩子卡片的动作区（卡片根是那个 `rounded-2xl` 容器，三个按钮都在它内部）。 */
function cardActions(studentName: string) {
  const heading = screen.getByRole('heading', { name: studentName });
  const card = heading.closest('.rounded-2xl');
  if (!card) throw new Error(`没找到 ${studentName} 的卡片容器`);
  return within(card as HTMLElement);
}

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: null });
  listMyStudentsMock.mockReset();
  listMyStudentsMock.mockResolvedValue([BOY, GIRL]);
  getUnreadMessageCountMock.mockReset();
  getUnreadMessageCountMock.mockResolvedValue(0);
  getParentPointsMock.mockReset();
  getParentPointsMock.mockResolvedValue(POINTS);
  getParentPointRulesMock.mockReset();
  getParentPointRulesMock.mockResolvedValue({ tasks: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  // ParentLayout 会把主题设成 parent，别泄漏给别的用例
  useThemeStore.setState({ mode: 'student-day' });
});

describe('ParentStudentsPage：积分与奖励入口', () => {
  it('每张卡片保留原有三个操作，并各自多一个「积分与奖励」', async () => {
    renderAt('/parent/students');

    expect(await screen.findByRole('heading', { name: '小明' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '小美' })).toBeInTheDocument();

    const first = cardActions('小明');
    expect(first.getByRole('button', { name: '重置密码' })).toBeInTheDocument();
    expect(first.getByRole('button', { name: '停用账号' })).toBeInTheDocument();
    expect(first.getByRole('button', { name: '学习配置' })).toBeInTheDocument();
    expect(first.getByRole('button', { name: '积分与奖励' })).toBeInTheDocument();

    // 两个孩子的卡各有一个入口，不是整页共用一个
    expect(screen.getAllByRole('button', { name: '积分与奖励' })).toHaveLength(2);
  });

  it('点第二个孩子的入口 → 真实导航到 /parent/rewards，且积分页取的是这个孩子', async () => {
    const { router } = renderAt('/parent/students');
    await screen.findByRole('heading', { name: '小美' });

    fireEvent.click(cardActions('小美').getByRole('button', { name: '积分与奖励' }));

    // 真实导航：路由当前位置真的变了，学生账号页被卸载
    await waitFor(() => expect(router.state.location.pathname).toBe('/parent/rewards'));
    expect(screen.queryByRole('heading', { name: '学生账号管理' })).not.toBeInTheDocument();

    // 锚点落在被点的那张卡上（不是顶栏回落出来的第一个孩子）
    expect(useParentStudentStore.getState().studentId).toBe(GIRL.id);

    // 页面真的渲染出来了，并且按 12 取数：锚点没先设好就会多出一次 11 的请求
    expect(await screen.findByTestId('points-panel-rules')).toHaveAttribute(
      'data-student-id',
      String(GIRL.id),
    );
    expect(getParentPointsMock.mock.calls.map((call) => call[0])).toEqual([GIRL.id]);
  });
});
