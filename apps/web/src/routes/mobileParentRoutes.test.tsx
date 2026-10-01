import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from './routeTable';

afterEach(cleanup);

// 布局里三条通知条都会发请求：统一静默，让测试聚焦路由与导航本身。
vi.mock('@/components/business/AlertBanner', () => ({ default: () => null }));
vi.mock('@/pages/parent/BillingNoticeBar', () => ({ default: () => null }));
vi.mock('@/pages/parent/SubscriptionNoticeBar', () => ({ default: () => null }));
vi.mock('@/services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/api')>()),
  listMyStudents: vi.fn().mockResolvedValue([
    { id: 1, parentId: 9, username: 'stu1', name: '小明', age: 10, grade: '四年级', schoolLevel: 'primary', isActive: true },
  ]),
  getSubscriptionStatus: vi.fn().mockRejectedValue(new Error('skip')),
}));

// RequireRole 按 localStorage 的 token（解 payload 校 exp）+ userRole 守卫
// （与 routeTable.test.tsx 同口径的 stub 登录态，不为好测而放宽守卫）。
function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

beforeEach(() => {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'parent');
});

afterEach(() => {
  localStorage.clear();
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
}

describe('/m/parent 移动路由组', () => {
  it('index 重定向到 dashboard', async () => {
    renderAt('/m/parent');
    expect(await screen.findByTestId('mobile-page-dashboard')).toBeTruthy();
  });

  it('more/:name 渲染电脑端占位页', async () => {
    renderAt('/m/parent/more/subscription');
    expect(await screen.findByText('该功能请在电脑端使用')).toBeTruthy();
  });

  it('底部导航有五个 Tab 且当前态正确', async () => {
    renderAt('/m/parent/dashboard');
    expect(await screen.findByTestId('mobile-page-dashboard')).toBeTruthy();
    expect(screen.getByTestId('tab-dashboard').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('tab-alerts').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('tab-errors')).toBeTruthy();
    expect(screen.getByTestId('tab-controls')).toBeTruthy();
    expect(screen.getByTestId('tab-more')).toBeTruthy();
  });
});
