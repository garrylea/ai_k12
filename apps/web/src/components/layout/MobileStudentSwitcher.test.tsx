import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter } from 'react-router-dom';
import MobileStudentSwitcher from './MobileStudentSwitcher';
import { useParentStudentStore } from '@/store/parentStudentStore';

afterEach(() => {
  cleanup();
  useParentStudentStore.setState({ studentId: null });
  localStorage.removeItem('parent-current-student');
});

const students = [
  { id: 1, parentId: 9, username: 'a', name: '小明', age: 10, grade: '四年级', schoolLevel: 'primary', isActive: true },
  { id: 2, parentId: 9, username: 'b', name: '小红', age: 13, grade: '初一', schoolLevel: 'junior', isActive: true },
];

vi.mock('@/services/api', () => ({ listMyStudents: vi.fn() }));
import { listMyStudents } from '@/services/api';
const mockList = vi.mocked(listMyStudents);

beforeEach(() => {
  // mock 的实现由各用例自设（Once 队列按注册序消费）；这里只清调用计数，
  // 让「第 N 次调用」的断言从本用例起算
  mockList.mockClear();
});

describe('MobileStudentSwitcher', () => {
  it('拉到列表后默认选中第一个孩子（无持久化 id 时）', async () => {
    mockList.mockResolvedValue(students);
    render(
      <MemoryRouter>
        <MobileStudentSwitcher />
      </MemoryRouter>,
    );
    await waitFor(() => expect(useParentStudentStore.getState().studentId).toBe(1));
    expect(screen.getByText(/小明/)).toBeTruthy();
  });

  it('点击展开并切换孩子，写回 store', async () => {
    mockList.mockResolvedValue(students);
    useParentStudentStore.setState({ studentId: 1 });
    render(
      <MemoryRouter>
        <MobileStudentSwitcher />
      </MemoryRouter>,
    );
    await screen.findByText(/小明/);
    await userEvent.click(screen.getByTestId('mobile-switcher-trigger'));
    await userEvent.click(screen.getByTestId('mobile-switcher-option-2'));
    expect(useParentStudentStore.getState().studentId).toBe(2);
  });

  it('持久化 id 不在列表中时回落到第一个孩子', async () => {
    mockList.mockResolvedValue(students);
    useParentStudentStore.setState({ studentId: 999 });
    render(
      <MemoryRouter>
        <MobileStudentSwitcher />
      </MemoryRouter>,
    );
    await waitFor(() => expect(useParentStudentStore.getState().studentId).toBe(1));
  });

  it('拉取失败只降级本块：显示重试，不抛错', async () => {
    mockList.mockRejectedValue(new Error('network'));
    render(
      <MemoryRouter>
        <MobileStudentSwitcher />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('mobile-switcher-retry')).toBeTruthy();
    mockList.mockResolvedValue(students);
    await userEvent.click(screen.getByTestId('mobile-switcher-retry'));
    await screen.findByText(/小明/);
  });

  it('pathname 变化触发静默重拉：列表后台替换、不闪「加载中…」', async () => {
    // 首次拉取正常返回；第二次（导航触发）用 deferred promise 控制在飞窗口
    mockList.mockResolvedValueOnce(students);
    const updated = [{ ...students[0], name: '明明' }, students[1]];
    let resolveSecond: (v: typeof updated) => void = () => {};
    mockList.mockImplementationOnce(
      () => new Promise<typeof updated>((resolve) => { resolveSecond = resolve; }),
    );
    render(
      <MemoryRouter initialEntries={['/m/parent/dashboard']}>
        <Link to="/m/parent/errors">去错题</Link>
        <MobileStudentSwitcher />
      </MemoryRouter>,
    );
    await screen.findByText(/小明/);

    // 导航改变 pathname → 重拉发起，但在飞期间旧列表仍在展示、无加载态
    await userEvent.click(screen.getByText('去错题'));
    expect(screen.getByText(/小明/)).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
    expect(mockList).toHaveBeenCalledTimes(2);

    // 新响应到位后整体替换列表，锚点不动（id 1 仍在新列表中）
    resolveSecond(updated);
    await screen.findByText(/明明/);
    expect(useParentStudentStore.getState().studentId).toBe(1);
  });
});
