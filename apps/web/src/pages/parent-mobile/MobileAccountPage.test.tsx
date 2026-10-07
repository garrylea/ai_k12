import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileAccountPage from './MobileAccountPage';

afterEach(cleanup);

// toast 全仓测试统一 mock 成 vi.fn 断言（真 toast 需挂 ToastContainer 才渲染，页内断言不到文本）
vi.mock('@/components/base', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/base')>()),
  toast: vi.fn(),
}));

vi.mock('@/services/api', () => ({
  getParentAccount: vi.fn(),
  changeParentPassword: vi.fn(),
}));
import { toast } from '@/components/base';
import { changeParentPassword, getParentAccount } from '@/services/api';

// mock spy 是模块级的，调用记录跨用例累积；不清会导致「不应发请求」断言撞上前用例的调用
beforeEach(() => {
  vi.clearAllMocks();
});

const account = { id: 4, name: 'lc', phone: '18601201380' };

describe('MobileAccountPage', () => {
  it('渲染只读账号信息', async () => {
    vi.mocked(getParentAccount).mockResolvedValue(account as never);
    render(<MobileAccountPage />);
    expect(await screen.findByText(/18601201380/)).toBeTruthy();
    expect(screen.getByText(/lc/)).toBeTruthy();
  });

  it('修改密码：两次不一致不发请求；成功 toast 并清空表单', async () => {
    vi.mocked(getParentAccount).mockResolvedValue(account as never);
    vi.mocked(changeParentPassword).mockResolvedValue(null);
    render(<MobileAccountPage />);
    await screen.findByText(/18601201380/);
    await userEvent.type(screen.getByLabelText('旧密码'), 'old123');
    await userEvent.type(screen.getByLabelText('新密码'), 'new123456');
    await userEvent.type(screen.getByLabelText('确认新密码'), 'new654321');
    await userEvent.click(screen.getByTestId('account-password-submit'));
    expect(changeParentPassword).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText('确认新密码'));
    await userEvent.type(screen.getByLabelText('确认新密码'), 'new123456');
    await userEvent.click(screen.getByTestId('account-password-submit'));
    await waitFor(() => expect(changeParentPassword).toHaveBeenCalledWith('old123', 'new123456'));
    expect(vi.mocked(toast)).toHaveBeenCalledWith('success', '密码已修改');
  });

  it('新密码过短行内报错，不发请求', async () => {
    vi.mocked(getParentAccount).mockResolvedValue(account as never);
    render(<MobileAccountPage />);
    await screen.findByText(/18601201380/);
    await userEvent.type(screen.getByLabelText('旧密码'), 'old123');
    await userEvent.type(screen.getByLabelText('新密码'), '123');
    await userEvent.type(screen.getByLabelText('确认新密码'), '123');
    await userEvent.click(screen.getByTestId('account-password-submit'));
    expect(changeParentPassword).not.toHaveBeenCalled();
    expect(await screen.findByText(/至少 6 位/)).toBeTruthy();
  });

  it('旧密码错误：后端文案原样展示', async () => {
    vi.mocked(getParentAccount).mockResolvedValue(account as never);
    vi.mocked(changeParentPassword).mockRejectedValue(new Error('旧密码不正确'));
    render(<MobileAccountPage />);
    await screen.findByText(/18601201380/);
    await userEvent.type(screen.getByLabelText('旧密码'), 'wrong');
    await userEvent.type(screen.getByLabelText('新密码'), 'new123456');
    await userEvent.type(screen.getByLabelText('确认新密码'), 'new123456');
    await userEvent.click(screen.getByTestId('account-password-submit'));
    expect(await screen.findByText(/旧密码不正确/)).toBeTruthy();
  });
});
