import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LoginPage from './LoginPage';
import { login } from '@/services/api';

/**
 * 登录页渲染测试。
 *
 * 回归钉子：登录表单此前不是 <form>，密码框按回车毫无反应，只能鼠标点按钮。
 * 现在输入区包在 <form> 里、登录按钮为 type=submit，回车即提交。
 * 用 userEvent（而非 fireEvent.keyDown）是因为 jsdom 不实现「输入框内回车隐式提交」，
 * 只有 userEvent 的 keyboard 行为层会模拟它 —— 这正是我们要钉住的用户路径。
 */

vi.mock('@/services/api', () => ({
  login: vi.fn(),
}));

const mockLogin = vi.mocked(login);

function renderLoginPage() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/student/entry" element={<div>student-entry-page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LoginPage', () => {
  it('密码框按回车触发登录并跳转学生入口页', async () => {
    const user = userEvent.setup();
    mockLogin.mockResolvedValue({
      token: 'token-1',
      user: { id: 1, name: '学生一', username: 'stu01', role: 'student' },
    });
    renderLoginPage();

    await user.type(screen.getByLabelText('账号'), 'stu01');
    await user.type(screen.getByLabelText('密码'), 'pw123456{Enter}');

    await waitFor(() => {
      expect(screen.getByText('student-entry-page')).toBeInTheDocument();
    });
    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledWith('stu01', 'pw123456');
  });

  it('鼠标点击登录按钮同样提交，且只调用一次 login（防 onClick+submit 双触发回归）', async () => {
    const user = userEvent.setup();
    mockLogin.mockResolvedValue({
      token: 'token-1',
      user: { id: 1, name: '学生一', username: 'stu01', role: 'student' },
    });
    renderLoginPage();

    await user.type(screen.getByLabelText('账号'), 'stu01');
    await user.type(screen.getByLabelText('密码'), 'pw123456');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledTimes(1);
    });
  });

  it('用户名或密码为空时回车不发请求，显示提示', async () => {
    const user = userEvent.setup();
    renderLoginPage();

    await user.type(screen.getByLabelText('密码'), 'pw123456{Enter}');

    expect(mockLogin).not.toHaveBeenCalled();
    expect(screen.getByText('请输入用户名和密码')).toBeInTheDocument();
  });
});
