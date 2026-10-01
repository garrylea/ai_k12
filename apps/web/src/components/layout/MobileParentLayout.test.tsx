import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MobileParentLayout from './MobileParentLayout';

afterEach(cleanup);

// 三条通知条都会发请求：统一静默，聚焦外壳本身（Tab / 主题 / Outlet）。
vi.mock('@/components/business/AlertBanner', () => ({ default: () => null }));
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
        <Route path="/m/parent" element={<MobileParentLayout />}>
          <Route path="dashboard" element={<div data-testid="outlet-probe">内容</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('MobileParentLayout', () => {
  it('写死 parent 主题，顶栏含学生切换器，底部四 Tab 导航', () => {
    renderLayout('/m/parent/dashboard');

    expect(document.querySelector('[data-theme="parent"]')).not.toBeNull();
    expect(screen.getByTestId('mobile-student-switcher')).toBeInTheDocument();
    for (const testId of ['tab-dashboard', 'tab-errors', 'tab-controls', 'tab-more']) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
    // aria-label 是无障碍口径（nav 角色），钉住不丢
    expect(screen.getByRole('navigation', { name: '家长移动端主导航' })).toBeInTheDocument();
  });

  it('子路由内容经 Outlet 渲染，当前 Tab 标记 aria-current="page"', () => {
    renderLayout('/m/parent/dashboard');

    expect(screen.getByTestId('outlet-probe')).toBeInTheDocument();
    expect(screen.getByTestId('tab-dashboard').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('tab-more').getAttribute('aria-current')).toBeNull();
  });
});
