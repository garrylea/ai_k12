import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ForgotPasswordPage from './ForgotPasswordPage';
import { requestPasswordReset, resetPassword } from '@/services/api';

/**
 * 忘记密码页渲染测试（渲染测试铁律）。核心用户路径：
 * 输手机号 → 获取验证码（页面直显模拟验证码 + 60s 倒计时）→
 * 填验证码与新密码 → 提示成功 → 自动跳回登录页。
 */

vi.mock('@/services/api', () => ({
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
}));

const mockRequest = vi.mocked(requestPasswordReset);
const mockReset = vi.mocked(resetPassword);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/forgot-password']}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/login" element={<div>login-page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('ForgotPasswordPage', () => {
  it('渲染学生口径说明、三个输入区与两个按钮', () => {
    renderPage();
    expect(screen.getByText(/学生密码请联系家长在家长端重置/)).toBeInTheDocument();
    expect(screen.getByLabelText('手机号')).toBeInTheDocument();
    expect(screen.getByLabelText('验证码')).toBeInTheDocument();
    expect(screen.getByLabelText('新密码', { selector: 'input' })).toBeInTheDocument();
    expect(screen.getByLabelText('确认新密码')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '获取验证码' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重置密码' })).toBeInTheDocument();
  });

  // spec（2026-10-09-forgot-password-design.md）：手机号不合法时**禁用**「获取验证码」，
  // 因此按钮点不动、内联错误提示不可达 —— 断言禁用 + 不发请求（原 brief 用例点按钮期待
  // 错误提示，与 spec 冲突；按「测试与设计文档冲突时测试错」改这里）。
  it('手机号格式不合法时按钮禁用，不发请求', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText('手机号'), '123');
    expect(screen.getByRole('button', { name: '获取验证码' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '获取验证码' }));
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('获取验证码成功：页面直显模拟验证码，按钮进入倒计时禁用', async () => {
    const user = userEvent.setup();
    mockRequest.mockResolvedValue({ code: '123456', expiresIn: 300 });
    renderPage();
    await user.type(screen.getByLabelText('手机号'), '13800000000');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));

    expect(await screen.findByTestId('displayed-code')).toHaveTextContent('123456');
    const btn = screen.getByRole('button', { name: /秒后可重发/ });
    expect(btn).toBeDisabled();
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('获取验证码失败：展示后端错误信息，不显示验证码', async () => {
    const user = userEvent.setup();
    mockRequest.mockRejectedValue(new Error('该手机号未注册'));
    renderPage();
    await user.type(screen.getByLabelText('手机号'), '13800000000');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));
    expect(await screen.findByText('该手机号未注册')).toBeInTheDocument();
    expect(screen.queryByTestId('displayed-code')).not.toBeInTheDocument();
  });

  it('两次新密码不一致时前端拦截，不发重置请求', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText('手机号'), '13800000000');
    await user.type(screen.getByLabelText('验证码'), '123456');
    await user.type(screen.getByLabelText('新密码', { selector: 'input' }), 'abc123');
    await user.type(screen.getByLabelText('确认新密码'), 'abc124');
    await user.click(screen.getByRole('button', { name: '重置密码' }));
    expect(mockReset).not.toHaveBeenCalled();
    expect(screen.getByText('两次输入的密码不一致')).toBeInTheDocument();
  });

  it('重置成功：提示成功并自动跳回登录页（spec §2.1：先提示后跳转）', async () => {
    // user-event 在 vitest 假定时器下会挂死（act 等待被 fake 的调度，仓内
    // LearningSessionShell.test.tsx 同款结论）：输入用真实时器，点击前再切假定时器，
    // 点击改用同步 fireEvent（user-event 的 click 在假定时器下同样挂死）。
    const user = userEvent.setup();
    mockReset.mockResolvedValue({ success: true });
    renderPage();
    await user.type(screen.getByLabelText('手机号'), '13800000000');
    await user.type(screen.getByLabelText('验证码'), '123456');
    await user.type(screen.getByLabelText('新密码', { selector: 'input' }), 'abc123');
    await user.type(screen.getByLabelText('确认新密码'), 'abc123');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('密码重置成功，正在返回登录页…')).toBeInTheDocument();
    expect(mockReset).toHaveBeenCalledWith('13800000000', '123456', 'abc123');

    // 1.2s 自动跳转
    await act(async () => {
      vi.advanceTimersByTime(1300);
    });
    expect(screen.getByText('login-page')).toBeInTheDocument();
  });

  it('重置失败：展示后端错误信息（如验证码过期），停留本页', async () => {
    const user = userEvent.setup();
    mockReset.mockRejectedValue(new Error('验证码已过期，请重新获取'));
    renderPage();
    await user.type(screen.getByLabelText('手机号'), '13800000000');
    await user.type(screen.getByLabelText('验证码'), '123456');
    await user.type(screen.getByLabelText('新密码', { selector: 'input' }), 'abc123');
    await user.type(screen.getByLabelText('确认新密码'), 'abc123');
    await user.click(screen.getByRole('button', { name: '重置密码' }));
    expect(await screen.findByText('验证码已过期，请重新获取')).toBeInTheDocument();
    expect(screen.queryByText('login-page')).not.toBeInTheDocument();
  });
});
