import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MobileParentLayout from './MobileParentLayout';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// 三条通知条都会发请求：统一静默，聚焦外壳本身（Tab / 主题 / Outlet）。
vi.mock('@/components/business/AlertBanner', () => ({
  default: (props: { alertsPath?: string }) => (
    <div data-testid="alert-banner-mock" data-alerts-path={props?.alertsPath ?? ''} />
  ),
}));
vi.mock('@/pages/parent/BillingNoticeBar', () => ({ default: () => null }));
vi.mock('@/pages/parent/SubscriptionNoticeBar', () => ({ default: () => null }));
// 切换器（Task 3 起为真实现）自拉数据、有自己的测试文件；外壳测试只关心它被渲染。
vi.mock('./MobileStudentSwitcher', () => ({
  default: () => <div data-testid="mobile-student-switcher" />,
}));

function renderLayout(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div data-testid="login-page-probe" />} />
        <Route path="/m/parent" element={<MobileParentLayout />}>
          <Route path="dashboard" element={<div data-testid="outlet-probe">内容</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('MobileParentLayout', () => {
  it('写死 parent 主题，顶栏含学生切换器，底部五 Tab 导航', () => {
    renderLayout('/m/parent/dashboard');

    expect(document.querySelector('[data-theme="parent"]')).not.toBeNull();
    expect(screen.getByTestId('mobile-student-switcher')).toBeInTheDocument();
    for (const testId of ['tab-dashboard', 'tab-alerts', 'tab-errors', 'tab-controls', 'tab-more']) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
    // aria-label 是无障碍口径（nav 角色），钉住不丢
    expect(screen.getByRole('navigation', { name: '家长移动端主导航' })).toBeInTheDocument();
  });

  it('AlertBanner 收到 alertsPath="/m/parent/alerts"（点击即已读逻辑在组件内，外壳不再拦截，回归钉子）', () => {
    renderLayout('/m/parent/dashboard');

    const banner = screen.getByTestId('alert-banner-mock');
    expect(banner.getAttribute('data-alerts-path')).toBe('/m/parent/alerts');
  });

  it('子路由内容经 Outlet 渲染，当前 Tab 标记 aria-current="page"', () => {
    renderLayout('/m/parent/dashboard');

    expect(screen.getByTestId('outlet-probe')).toBeInTheDocument();
    expect(screen.getByTestId('tab-dashboard').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('tab-alerts').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('tab-more').getAttribute('aria-current')).toBeNull();
  });

  it('壳级退出登录：点击后清空鉴权并跳登录页（移动端唯一退出入口，回归钉子）', async () => {
    localStorage.setItem('token', 't');
    localStorage.setItem('userId', '1');
    localStorage.setItem('username', '13800000000');
    localStorage.setItem('userRole', 'parent');
    renderLayout('/m/parent/dashboard');

    // aria-label 与全仓 4 个既有 LogoutButton 测试同口径，勿改
    await userEvent.click(screen.getByLabelText('退出登录'));
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('userId')).toBeNull();
    expect(localStorage.getItem('username')).toBeNull();
    expect(localStorage.getItem('userRole')).toBeNull();
    expect(screen.getByTestId('login-page-probe')).toBeInTheDocument();
  });
});
