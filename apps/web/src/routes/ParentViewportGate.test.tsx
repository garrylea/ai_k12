import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import ParentViewportGate, { mobileParentPath } from './ParentViewportGate';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });
});

const desktopProbe = <div data-testid="desktop-parent">desktop-parent-layout</div>;

function renderGate(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/m/parent/dashboard', element: <div data-testid="m-dashboard" /> },
      { path: '/m/parent/alerts', element: <div data-testid="m-alerts" /> },
      { path: '/m/parent/errors', element: <div data-testid="m-errors" /> },
      { path: '/m/parent/controls', element: <div data-testid="m-controls" /> },
      { path: '/m/parent/messages', element: <div data-testid="m-messages" /> },
      { path: '/m/parent/students', element: <div data-testid="m-students" /> },
      { path: '/m/parent/goals', element: <div data-testid="m-goals" /> },
      { path: '/m/parent/account', element: <div data-testid="m-account" /> },
      { path: '/m/parent/points', element: <div data-testid="m-points" /> },
      { path: '/m/parent/report', element: <div data-testid="m-report" /> },
      { path: '/m/parent/chat-logs', element: <div data-testid="m-chatlogs" /> },
      { path: '/m/parent/students/:id/config', element: <div data-testid="m-config" /> },
      { path: '/m/parent/more/:name', element: <div data-testid="m-more" /> },
      { path: '/parent/*', element: <ParentViewportGate>{desktopProbe}</ParentViewportGate> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
}

describe('ParentViewportGate', () => {
  it('mobileParentPath：v1 四页映射同名，其余功能段映射 more 占位', () => {
    expect(mobileParentPath('/parent/dashboard')).toBe('/m/parent/dashboard');
    expect(mobileParentPath('/parent/alerts')).toBe('/m/parent/alerts');
    expect(mobileParentPath('/parent/errors')).toBe('/m/parent/errors');
    expect(mobileParentPath('/parent/controls')).toBe('/m/parent/controls');
    expect(mobileParentPath('/parent/subscription')).toBe('/m/parent/more/subscription');
    expect(mobileParentPath('/parent/unknown-thing')).toBe('/m/parent/more/students');
  });

  it('mobileParentPath：新增 2A 段映射到真实移动页（含带 id 的 config）', () => {
    expect(mobileParentPath('/parent/messages')).toBe('/m/parent/messages');
    expect(mobileParentPath('/parent/students')).toBe('/m/parent/students');
    expect(mobileParentPath('/parent/goals')).toBe('/m/parent/goals');
    expect(mobileParentPath('/parent/account')).toBe('/m/parent/account');
    expect(mobileParentPath('/parent/students/7/config')).toBe('/m/parent/students/7/config');
  });

  it('mobileParentPath：2B 段映射（rewards 沿用指向积分页）', () => {
    expect(mobileParentPath('/parent/points')).toBe('/m/parent/points');
    expect(mobileParentPath('/parent/report')).toBe('/m/parent/report');
    expect(mobileParentPath('/parent/chat-logs')).toBe('/m/parent/chat-logs');
    expect(mobileParentPath('/parent/rewards')).toBe('/m/parent/points');
  });

  it('窄屏访问 /parent/students/7/config → 直跳移动配置页', () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
    renderGate('/parent/students/7/config');
    expect(screen.getByTestId('m-config')).toBeTruthy();
  });

  it('窄屏（<768px）访问桌面家长页 → 跳移动版对应页（旧 token 不经登录的兜底）', () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
    renderGate('/parent/dashboard');
    expect(screen.getByTestId('m-dashboard')).toBeTruthy();
    expect(screen.queryByTestId('desktop-parent')).toBeNull();
  });

  it('窄屏访问不在移动范围的桌面页 → 跳「更多」占位（订阅仍为占位）', () => {
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true, writable: true });
    renderGate('/parent/subscription');
    expect(screen.getByTestId('m-more')).toBeTruthy();
  });

  it('窄屏访问 /parent/rewards → 直跳移动积分页（2B 起为真实页）', () => {
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true, writable: true });
    renderGate('/parent/rewards');
    expect(screen.getByTestId('m-points')).toBeTruthy();
  });

  it('宽屏（≥768px，iPad 横屏/PC）桌面家长台原样渲染，不跳转', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1180, configurable: true, writable: true });
    renderGate('/parent/dashboard');
    expect(screen.getByTestId('desktop-parent')).toBeTruthy();
    expect(screen.queryByTestId('m-dashboard')).toBeNull();
  });
});
