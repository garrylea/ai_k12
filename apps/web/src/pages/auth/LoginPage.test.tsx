import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LoginPage from './LoginPage';
import { login } from '@/services/api';
import { isDesktopShell } from '@/kiosk/desktopBridge';
import { MOBILE_VIEWPORT_BREAKPOINT } from '@/constants';

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

vi.mock('@/kiosk/desktopBridge', () => ({
  isDesktopShell: vi.fn(),
}));

const mockLogin = vi.mocked(login);
const mockIsDesktopShell = vi.mocked(isDesktopShell);

function renderLoginPage() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/student/entry" element={<div>student-entry-page</div>} />
        <Route path="/m/parent" element={<div>parent-mobile-home</div>} />
        <Route path="/parent/students" element={<div>parent-students-page</div>} />
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

describe('LoginPage 家长落点按视口分流', () => {
  it('窄屏（<768px）家长登录落 /m/parent', async () => {
    const user = userEvent.setup();
    mockLogin.mockResolvedValue({
      token: 't',
      user: { id: 1, role: 'parent', name: null, username: undefined, phone: '13800000000' },
    });
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      value: MOBILE_VIEWPORT_BREAKPOINT - 1,
      configurable: true,
    });
    try {
      renderLoginPage();
      await user.type(screen.getByLabelText('账号'), '13800000000');
      await user.type(screen.getByLabelText('密码'), 'pw123456');
      await user.click(screen.getByRole('button', { name: '登录' }));
      expect(await screen.findByText('parent-mobile-home')).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
    }
  });

  it('宽屏家长登录仍落 /parent/students（原行为不变）', async () => {
    // 分流落地后的回归钉子：innerWidth 保持 jsdom 默认 1024，落点应仍为 /parent/students。
    const user = userEvent.setup();
    mockLogin.mockResolvedValue({
      token: 't',
      user: { id: 1, role: 'parent', name: null, username: undefined, phone: '13800000000' },
    });
    renderLoginPage();
    await user.type(screen.getByLabelText('账号'), '13800000000');
    await user.type(screen.getByLabelText('密码'), 'pw123456');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('parent-students-page')).toBeInTheDocument();
  });
});

describe('LoginPage 记住我', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // Web 端（jsdom 无 desktop 桥）：默认不勾；PC App 用例里单独改 true
    mockIsDesktopShell.mockReturnValue(false);
  });

  it('默认不勾「记住我」：登录成功后 token 只写 sessionStorage，不写 localStorage', async () => {
    const user = userEvent.setup();
    mockLogin.mockResolvedValueOnce({
      token: 'jwt-x',
      user: { id: 9, role: 'student', name: '小明', username: 'xiaoming' },
    });
    renderLoginPage();
    await user.type(screen.getByLabelText('账号'), 'xiaoming');
    await user.type(screen.getByLabelText('密码'), 'pw123456');
    // 默认未勾选：断言 checkbox 存在且 unchecked
    const box = screen.getByLabelText('记住我') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('student-entry-page')).toBeInTheDocument();
    expect(sessionStorage.getItem('token')).toBe('jwt-x');
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('勾选「记住我」：登录成功后 token 写 localStorage（现状行为）', async () => {
    const user = userEvent.setup();
    mockLogin.mockResolvedValueOnce({
      token: 'jwt-y',
      user: { id: 9, role: 'student', name: '小明', username: 'xiaoming' },
    });
    renderLoginPage();
    await user.type(screen.getByLabelText('账号'), 'xiaoming');
    await user.type(screen.getByLabelText('密码'), 'pw123456');
    await user.click(screen.getByLabelText('记住我'));
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('student-entry-page')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBe('jwt-y');
    expect(sessionStorage.getItem('token')).toBeNull();
  });

  it('PC App（Electron）环境默认勾选：登录成功后 token 写 localStorage（用户裁决：壳内保持 7 天免登旧行为）', async () => {
    mockIsDesktopShell.mockReturnValue(true);
    const user = userEvent.setup();
    mockLogin.mockResolvedValueOnce({
      token: 'jwt-pc',
      user: { id: 9, role: 'student', name: '小明', username: 'xiaoming' },
    });
    renderLoginPage();

    const box = screen.getByLabelText('记住我') as HTMLInputElement;
    expect(box.checked).toBe(true);

    await user.type(screen.getByLabelText('账号'), 'xiaoming');
    await user.type(screen.getByLabelText('密码'), 'pw123456');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('student-entry-page')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBe('jwt-pc');
    expect(sessionStorage.getItem('token')).toBeNull();
  });
});
