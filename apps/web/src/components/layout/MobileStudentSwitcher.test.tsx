import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('MobileStudentSwitcher', () => {
  it('拉到列表后默认选中第一个孩子（无持久化 id 时）', async () => {
    mockList.mockResolvedValue(students);
    render(<MobileStudentSwitcher />);
    await waitFor(() => expect(useParentStudentStore.getState().studentId).toBe(1));
    expect(screen.getByText(/小明/)).toBeTruthy();
  });

  it('点击展开并切换孩子，写回 store', async () => {
    mockList.mockResolvedValue(students);
    useParentStudentStore.setState({ studentId: 1 });
    render(<MobileStudentSwitcher />);
    await screen.findByText(/小明/);
    await userEvent.click(screen.getByTestId('mobile-switcher-trigger'));
    await userEvent.click(screen.getByTestId('mobile-switcher-option-2'));
    expect(useParentStudentStore.getState().studentId).toBe(2);
  });

  it('持久化 id 不在列表中时回落到第一个孩子', async () => {
    mockList.mockResolvedValue(students);
    useParentStudentStore.setState({ studentId: 999 });
    render(<MobileStudentSwitcher />);
    await waitFor(() => expect(useParentStudentStore.getState().studentId).toBe(1));
  });

  it('拉取失败只降级本块：显示重试，不抛错', async () => {
    mockList.mockRejectedValue(new Error('network'));
    render(<MobileStudentSwitcher />);
    expect(await screen.findByTestId('mobile-switcher-retry')).toBeTruthy();
    mockList.mockResolvedValue(students);
    await userEvent.click(screen.getByTestId('mobile-switcher-retry'));
    await screen.findByText(/小明/);
  });
});
