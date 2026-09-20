import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import ParentLayout from './ParentLayout';
import {
  getUnreadMessageCount,
  getParentAlerts,
  listMyStudents,
  type MyStudentItem,
  type ParentAlertItem,
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
    getParentAlerts: vi.fn(),
  };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMessageCountMock = vi.mocked(getUnreadMessageCount);
const getParentAlertsMock = vi.mocked(getParentAlerts);

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

const MESSAGE = '检测到孩子在学习中发起了与学习无关的闲聊';

function alertItem(over: Partial<ParentAlertItem> = {}): ParentAlertItem {
  return {
    id: 1,
    studentId: 1,
    studentName: '小刚',
    type: 'off_topic',
    level: 'warning',
    message: MESSAGE,
    context: '你喜欢什么游戏？',
    dialogueId: 88,
    isRead: false,
    createdAt: '2026-09-20T10:00:00.000Z',
    ...over,
  };
}

function page(items: ParentAlertItem[]) {
  return { items, total: items.length, page: 1, pageSize: 1 };
}

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
  getParentAlertsMock.mockReset().mockResolvedValue(page([]));
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

  it('Banner：当前孩子有未读 warning 预警 → 渲染（标题=message）', async () => {
    getParentAlertsMock.mockResolvedValue(page([alertItem({ level: 'warning' })]));

    renderLayout();

    expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
    expect(screen.getByText('点击查看详情，建议适时介入')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即查看' })).toBeInTheDocument();
    // 请求口径：只看未读 + 只取 1 条（spec §5.1）
    expect(getParentAlertsMock).toHaveBeenCalledWith({
      studentId: 1,
      unreadOnly: true,
      pageSize: 1,
    });
  });

  it('Banner：critical 也渲染', async () => {
    getParentAlertsMock.mockResolvedValue(page([alertItem({ level: 'critical' })]));

    renderLayout();

    expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
  });

  it('Banner：只有 info 或空 → 不渲染（info 只进列表页）', async () => {
    getParentAlertsMock.mockResolvedValue(page([alertItem({ level: 'info' })]));

    renderLayout();

    await waitFor(() => expect(getParentAlertsMock).toHaveBeenCalled());
    expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '立即查看' })).not.toBeInTheDocument();
  });

  it('Banner：请求失败 → 静默不渲染（不占位、不抖动）', async () => {
    getParentAlertsMock.mockRejectedValue(new Error('boom'));

    renderLayout();

    await waitFor(() => expect(getParentAlertsMock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '立即查看' })).not.toBeInTheDocument();
    // 顶栏其余部分不受影响
    expect(screen.getByText('家长端 · 监管空间')).toBeInTheDocument();
  });

  it('Banner：没有孩子（studentId 为 null）→ 不请求、不渲染', async () => {
    // 列表为空 → StudentSwitcher 不回落出 studentId，锚点保持 null
    listMyStudentsMock.mockResolvedValue([]);

    renderLayout();

    expect(await screen.findByText('还没有孩子账号')).toBeInTheDocument();
    expect(getParentAlertsMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '立即查看' })).not.toBeInTheDocument();
  });

  it('Banner：点「立即查看」→ 跳 /parent/alerts', async () => {
    getParentAlertsMock.mockResolvedValue(page([alertItem()]));

    renderLayout();

    fireEvent.click(await screen.findByRole('button', { name: '立即查看' }));

    expect(await screen.findByText('预警中心页')).toBeInTheDocument();
  });

  it('Banner：切孩子后、新请求未回来前，不得继续显示上一个孩子的预警（派生状态带 studentId）', async () => {
    // 两个孩子，才切得动（只有一个孩子时 StudentSwitcher 会回落回它）
    const SECOND: MyStudentItem = { ...STUDENT, id: 2, username: 'student2', name: '小红' };
    listMyStudentsMock.mockResolvedValue([STUDENT, SECOND]);
    getParentAlertsMock.mockResolvedValueOnce(page([alertItem({ message: '一号孩子的预警' })]));

    renderLayout();
    expect(await screen.findByText('一号孩子的预警')).toBeInTheDocument();

    // 切到 2 号孩子：新请求**挂起不返回**（模拟慢网络）
    getParentAlertsMock.mockImplementation(() => new Promise(() => {}));
    useParentStudentStore.setState({ studentId: 2 });

    // 若不按 studentId 归属过滤，此刻会拿「一号孩子的预警」渲染给二号孩子看
    await waitFor(() => expect(screen.queryByText('一号孩子的预警')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '立即查看' })).not.toBeInTheDocument();
  });
});
