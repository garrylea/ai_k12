import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RegisterPage from './RegisterPage';
import { registerParent } from '@/services/api';

/**
 * 注册页渲染测试。
 *
 * 与 LoginPage 同源的回归钉子：注册表单此前不是 <form>，密码框按回车毫无反应，
 * 只能鼠标点「完成注册」。现在输入区包在 <form> 里、按钮为 type=submit。
 * 用 userEvent（而非 fireEvent.keyDown）是因为 jsdom 不实现「输入框内回车隐式提交」。
 */

vi.mock('@/services/api', () => ({
  registerParent: vi.fn(),
}));

const mockRegister = vi.mocked(registerParent);

function renderRegisterPage() {
  return render(
    <MemoryRouter initialEntries={['/register']}>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/parent/students" element={<div>parent-students-page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('RegisterPage', () => {
  it('密码框按回车触发注册并跳转家长学生列表页', async () => {
    const user = userEvent.setup();
    mockRegister.mockResolvedValue({
      token: 'token-1',
      user: { id: 1, name: '张三', role: 'parent', phone: '13800138000' },
    });
    renderRegisterPage();

    await user.type(screen.getByLabelText('手机号'), '13800138000');
    await user.type(screen.getByLabelText('姓名（可选）'), '张三');
    await user.type(screen.getByLabelText('设置密码'), 'pw123456{Enter}');

    await waitFor(() => {
      expect(screen.getByText('parent-students-page')).toBeInTheDocument();
    });
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith('13800138000', 'pw123456', '张三');
  });

  it('鼠标点击完成注册按钮同样提交，且只调用一次 registerParent（防 onClick+submit 双触发回归）', async () => {
    const user = userEvent.setup();
    mockRegister.mockResolvedValue({
      token: 'token-1',
      user: { id: 1, name: '张三', role: 'parent', phone: '13800138000' },
    });
    renderRegisterPage();

    await user.type(screen.getByLabelText('手机号'), '13800138000');
    await user.type(screen.getByLabelText('设置密码'), 'pw123456');
    await user.click(screen.getByRole('button', { name: '完成注册' }));

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });
  });

  it('手机号非法时回车不发请求，显示校验提示', async () => {
    const user = userEvent.setup();
    renderRegisterPage();

    await user.type(screen.getByLabelText('手机号'), '123');
    await user.type(screen.getByLabelText('设置密码'), 'pw123456{Enter}');

    expect(mockRegister).not.toHaveBeenCalled();
    expect(screen.getByText('请输入 11 位手机号')).toBeInTheDocument();
  });
});
