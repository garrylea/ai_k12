import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom';
import RequireRole from '../RequireRole';
import { routes } from '../routeTable';
import { AdminNav } from '@/components/layout/AdminNav';
import LoginPage from '@/pages/auth/LoginPage';
import { login } from '@/services/api';
import { useAdminBillingBadgeStore } from '@/store/adminBillingBadgeStore';
import { useThemeStore } from '@/store/themeStore';

/**
 * Task 8 骨架回归：教研角色进入 /research 的守卫、路由表映射、侧栏与登录分流。
 *
 * 鉴权按真实口径走 authStorage（localStorage 的 token/userRole + 未过期 exp），
 * 不为好测而放宽守卫；与 routeTable.test.tsx 同款。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    login: vi.fn(),
    // AdminNav 挂载会拉订阅角标；骨架测试不关心它，给个空结果避免真实 fetch。
    listBillingClaims: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 1 }),
  };
});

const mockLogin = vi.mocked(login);

function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

function setSession(role: string) {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', role);
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  useThemeStore.setState({ mode: 'student-day' });
  useAdminBillingBadgeStore.setState({ pendingCount: null });
});

describe('RequireRole 支持 researcher', () => {
  it('researcher 会话允许进入教研路由', () => {
    setSession('researcher');
    render(
      <MemoryRouter>
        <RequireRole role="researcher">
          <div>教研内容</div>
        </RequireRole>
      </MemoryRouter>,
    );
    expect(screen.getByText('教研内容')).toBeInTheDocument();
  });

  it('角色不符（admin）被挡回登录页', () => {
    setSession('admin');
    render(
      <MemoryRouter initialEntries={['/research']}>
        <Routes>
          <Route path="/research" element={<RequireRole role="researcher"><div>教研内容</div></RequireRole>} />
          <Route path="/login" element={<div>login-page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('login-page')).toBeInTheDocument();
    expect(screen.queryByText('教研内容')).not.toBeInTheDocument();
  });

  it('无有效会话被挡回登录页', () => {
    render(
      <MemoryRouter initialEntries={['/research']}>
        <Routes>
          <Route path="/research" element={<RequireRole role="researcher"><div>教研内容</div></RequireRole>} />
          <Route path="/login" element={<div>login-page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('login-page')).toBeInTheDocument();
  });
});

describe('routeTable 教研路由组', () => {
  it('/research 重定向到 /research/papers 并渲染教研侧栏', () => {
    setSession('researcher');
    renderAt('/research');
    expect(screen.getByRole('link', { name: '试卷管理' })).toHaveAttribute('href', '/research/papers');
    expect(screen.getByRole('link', { name: '审计日志' })).toHaveAttribute('href', '/research/audit');
    // 侧栏底部与管理员一致：头像 + 用户 + 退出图标
    const nav = screen.getByRole('complementary');
    expect(within(nav).getAllByText('研').length).toBeGreaterThanOrEqual(2);
    expect(within(nav).getByText('教研员')).toBeInTheDocument();
    expect(within(nav).getAllByText('教研空间').length).toBeGreaterThanOrEqual(2);
    expect(within(nav).getByRole('button', { name: '退出登录' })).toBeInTheDocument();
  });

  it.each(['/research/papers', '/research/papers/7', '/research/audit'])(
    '%s 在 researcher 守卫下可达',
    (path) => {
      setSession('researcher');
      renderAt(path);
      expect(screen.getByRole('link', { name: '试卷管理' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: '审计日志' })).toBeInTheDocument();
    },
  );

  it('非 researcher 访问 /research/papers 被挡回登录页', () => {
    setSession('student');
    renderAt('/research/papers');
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
  });

  it('admin 路由组不再含 papers 子路由', () => {
    const admin = routes.find((r) => r.path === '/admin');
    expect(admin?.children?.some((c) => c.path === 'papers')).toBe(false);
  });

  it('管理端侧栏不再有「试卷管理」入口', () => {
    render(
      <MemoryRouter>
        <AdminNav />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: '试卷管理' })).not.toBeInTheDocument();
  });
});

describe('登录分流', () => {
  function renderLoginRoutes() {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/research" element={<div>research-home</div>} />
          <Route path="/admin" element={<div>admin-home</div>} />
          <Route path="/student/entry" element={<div>student-entry</div>} />
          <Route path="/parent/students" element={<div>parent-students</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  async function loginAs(role: string) {
    const user = userEvent.setup();
    mockLogin.mockResolvedValueOnce({
      token: 't',
      user: { id: 1, role: role as 'researcher', name: null, username: 'u' },
    });
    renderLoginRoutes();
    await user.type(screen.getByLabelText('账号'), 'u');
    await user.type(screen.getByLabelText('密码'), 'pw');
    await user.click(screen.getByRole('button', { name: '登录' }));
  }

  it('researcher 登录后落 /research', async () => {
    await loginAs('researcher');
    expect(await screen.findByText('research-home')).toBeInTheDocument();
  });

  it('admin 登录后仍落 /admin（无回归）', async () => {
    await loginAs('admin');
    expect(await screen.findByText('admin-home')).toBeInTheDocument();
  });

  it('student 登录后仍落 /student/entry（无回归）', async () => {
    await loginAs('student');
    expect(await screen.findByText('student-entry')).toBeInTheDocument();
  });
});
