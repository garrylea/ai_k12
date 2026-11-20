import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminAccountsPage from './AdminAccountsPage';
import {
  createResearcher,
  listResearchers,
  resetResearcherPassword,
  searchParents,
  setResearcherStatus,
  type AdminResearcherItem,
} from '@/services/api';
import { toast } from '@/components/base';

/**
 * 账号管理「教研员」Tab 回归（任务 13）：
 * 列表 / 新建（role 固定 researcher 由后端保证）/ 启用停用 / 重置密码。
 * 停用必须走确认弹窗（文案提示立即下线），启用直接调用。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    searchParents: vi.fn(),
    searchStudents: vi.fn(),
    setParentStatus: vi.fn(),
    setStudentStatusAdmin: vi.fn(),
    listResearchers: vi.fn(),
    createResearcher: vi.fn(),
    setResearcherStatus: vi.fn(),
    resetResearcherPassword: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const listMock = vi.mocked(listResearchers);
const createMock = vi.mocked(createResearcher);
const statusMock = vi.mocked(setResearcherStatus);
const resetMock = vi.mocked(resetResearcherPassword);
const parentsMock = vi.mocked(searchParents);
const toastMock = vi.mocked(toast);

function researcherOf(over: Partial<AdminResearcherItem> = {}): AdminResearcherItem {
  return {
    id: 7,
    username: 'teacher01',
    name: '教研甲',
    isActive: true,
    createdAt: '2026-11-19T12:00:00.000Z',
    ...over,
  };
}

async function openResearchersTab() {
  render(<AdminAccountsPage />);
  fireEvent.click(screen.getByRole('button', { name: '教研员' }));
  await waitFor(() => expect(listMock).toHaveBeenCalled(), { timeout: 2000 });
}

beforeEach(() => {
  vi.clearAllMocks();
  parentsMock.mockResolvedValue([]);
  listMock.mockResolvedValue({ items: [researcherOf()] });
  createMock.mockResolvedValue({ id: 8, username: 'teacher02', name: null, isActive: true });
  statusMock.mockResolvedValue(null);
  resetMock.mockResolvedValue(null);
});

// globals:false —— 必须自己清理 DOM，否则用例间选择器重复命中。
afterEach(() => cleanup());

describe('AdminAccountsPage 教研员 Tab', () => {
  it('切到教研员：列出用户名/姓名/状态/创建时间', async () => {
    await openResearchersTab();

    expect(await screen.findByText('teacher01')).toBeTruthy();
    expect(screen.getByText('教研甲')).toBeTruthy();
    expect(screen.getByText('正常')).toBeTruthy();
    expect(screen.getByText('2026/11/19')).toBeTruthy();
  });

  it('新建教研员：填表提交后调用 createResearcher 并刷新', async () => {
    await openResearchersTab();
    fireEvent.click(screen.getByRole('button', { name: '新建教研员' }));

    fireEvent.change(screen.getByPlaceholderText('字母、数字、下划线，3-50 位'), {
      target: { value: 'teacher02' },
    });
    fireEvent.change(screen.getByPlaceholderText('选填，最长 50 字'), {
      target: { value: '教研乙' },
    });
    fireEvent.change(screen.getByPlaceholderText('6-72 位'), {
      target: { value: 'pass1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        username: 'teacher02',
        name: '教研乙',
        password: 'pass1234',
      }),
    );
    expect(toastMock).toHaveBeenCalledWith('success', '已新建教研员');
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });

  it('停用需确认，确认后调用 status=false（提示立即下线）', async () => {
    await openResearchersTab();
    fireEvent.click(await screen.findByRole('button', { name: '停用' }));

    expect(screen.getByText(/停用后 teacher01 立即下线/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('确认'));

    await waitFor(() => expect(statusMock).toHaveBeenCalledWith(7, false));
  });

  it('启用直接调用 status=true（无确认弹窗）', async () => {
    listMock.mockResolvedValue({ items: [researcherOf({ isActive: false })] });
    await openResearchersTab();

    fireEvent.click(await screen.findByRole('button', { name: '启用' }));
    await waitFor(() => expect(statusMock).toHaveBeenCalledWith(7, true));
    expect(screen.queryByLabelText('确认')).toBeNull();
  });

  it('重置密码：弹窗输入新密码后调用 resetResearcherPassword', async () => {
    await openResearchersTab();
    fireEvent.click(await screen.findByRole('button', { name: '重置密码' }));

    fireEvent.change(screen.getByPlaceholderText('6-72 位'), {
      target: { value: 'newpass1' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(resetMock).toHaveBeenCalledWith(7, 'newpass1'));
    expect(toastMock).toHaveBeenCalledWith('success', '已重置 teacher01 的密码');
  });
});
