import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import ParentLayout from './ParentLayout';
import { getUnreadMessageCount, listMyStudents, type MyStudentItem } from '@/services/api';
import { useThemeStore } from '@/store/themeStore';

/**
 * `ParentLayout` 回归：假下拉换成 `StudentSwitcher` 时，**别把别的东西顺手删了**。
 *
 * 钉两件事：
 * 1. 顶栏左端真的有 `StudentSwitcher`（真实数据源）；
 * 2. 那条假 Banner（`hasAlert = true`，异常预警 pipeline 的占位）**仍在**，
 *    本次任务不碰它。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, listMyStudents: vi.fn(), getUnreadMessageCount: vi.fn() };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMessageCountMock = vi.mocked(getUnreadMessageCount);

const STUDENT: MyStudentItem = {
  id: 1,
  parentId: 1,
  username: 'student1',
  name: '小刚',
  age: 9,
  grade: '四年级',
  schoolLevel: 'primary',
  isActive: true,
};

function renderLayout() {
  const router = createMemoryRouter(
    [
      {
        path: '/parent',
        element: <ParentLayout />,
        children: [{ path: 'students', element: <div>学生账号页</div> }],
      },
    ],
    { initialEntries: ['/parent/students'] },
  );
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  localStorage.clear();
  listMyStudentsMock.mockReset().mockResolvedValue([STUDENT]);
  getUnreadMessageCountMock.mockReset().mockResolvedValue(0);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // ParentLayout 会把主题设成 parent，别泄漏给别的用例
  useThemeStore.setState({ mode: 'student-day' });
});

describe('ParentLayout', () => {
  it('顶栏左端挂的是 StudentSwitcher（真实数据源，不是假下拉）', async () => {
    const { container } = renderLayout();

    const trigger = await screen.findByTestId('student-switcher-trigger');
    expect(trigger).toHaveTextContent('小刚');
    expect(trigger).toHaveTextContent('（四年级）');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // 旧的硬编码假数据（写死的「小明（三年级）」）不许再出现
    expect(screen.queryByText('小明（三年级）')).not.toBeInTheDocument();
    expect(container.querySelector('[data-theme="parent"]')).not.toBeNull();
  });

  it('假 Banner 仍在（异常预警占位，本次不碰）', () => {
    renderLayout();

    expect(
      screen.getByText('异常预警：检测到孩子今日 3 次闲聊偏离学习'),
    ).toBeInTheDocument();
    expect(screen.getByText('家长端 · 监管空间')).toBeInTheDocument();
  });
});
