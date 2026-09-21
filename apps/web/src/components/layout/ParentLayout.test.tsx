import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import ParentLayout from './ParentLayout';
import {
  getUnreadMessageCount,
  getParentUnreadAlerts,
  markParentAlertRead,
  listMyStudents,
  type MyStudentItem,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { useThemeStore } from '@/store/themeStore';

/**
 * `ParentLayout` 回归：
 * 1. 顶栏左端真的有 `StudentSwitcher`（真实数据源）；
 * 2. 顶部 Banner 是**真预警**（spec §5.1 状态机），不再是 `hasAlert = true` 的假占位。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listMyStudents: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getParentUnreadAlerts: vi.fn(),
    markParentAlertRead: vi.fn().mockResolvedValue(null),
  };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMessageCountMock = vi.mocked(getUnreadMessageCount);
const getParentUnreadAlertsMock = vi.mocked(getParentUnreadAlerts);
const markParentAlertReadMock = vi.mocked(markParentAlertRead);

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

const MESSAGE = '孩子在学习页面 5 分钟无操作';

function renderLayout() {
  const router = createMemoryRouter(
    [
      {
        path: '/parent',
        element: <ParentLayout />,
        children: [
          { path: 'students', element: <div>学生账号页</div> },
          { path: 'alerts', element: <div>预警中心页</div> },
        ],
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
  getParentUnreadAlertsMock.mockReset().mockResolvedValue({ items: [], total: 0 });
  markParentAlertReadMock.mockReset().mockResolvedValue(null);
  useParentStudentStore.setState({ studentId: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
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

  it('Banner：有未读预警 → AlertBanner 渲染（不依赖当前选中孩子）', async () => {
    useParentStudentStore.setState({ studentId: null });
    getParentUnreadAlertsMock.mockResolvedValue({
      items: [
        { id: 1, type: 'idle', level: 'info', message: MESSAGE, studentName: '小刚', createdAt: '2026-09-20T10:00:00.000Z' },
      ],
      total: 1,
    });
    renderLayout();
    expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
  });

  it('Banner：无未读 → 不渲染', async () => {
    renderLayout();
    await waitFor(() => expect(getParentUnreadAlertsMock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '立即查看' })).not.toBeInTheDocument();
  });

  it('Banner：点「立即查看」→ 跳 /parent/alerts 且标已读', async () => {
    getParentUnreadAlertsMock
      .mockResolvedValueOnce({
        items: [
          { id: 1, type: 'idle', level: 'info', message: MESSAGE, studentName: '小刚', createdAt: '2026-09-20T10:00:00.000Z' },
        ],
        total: 1,
      })
      .mockResolvedValue({ items: [], total: 0 });
    renderLayout();
    fireEvent.click(await screen.findByRole('button', { name: '立即查看' }));
    expect(await screen.findByText('预警中心页')).toBeInTheDocument();
    await waitFor(() => expect(markParentAlertReadMock).toHaveBeenCalledWith(1));
  });

  it('Banner：请求失败 → 静默不渲染（不占位、不抖动）', async () => {
    getParentUnreadAlertsMock.mockRejectedValue(new Error('net'));
    renderLayout();
    await waitFor(() => expect(getParentUnreadAlertsMock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '立即查看' })).not.toBeInTheDocument();
  });
});
