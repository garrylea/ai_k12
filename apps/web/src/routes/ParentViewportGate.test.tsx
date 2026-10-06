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
    expect(mobileParentPath('/parent/rewards')).toBe('/m/parent/more/points');
    expect(mobileParentPath('/parent/subscription')).toBe('/m/parent/more/subscription');
    expect(mobileParentPath('/parent/students/3/config')).toBe('/m/parent/more/students');
    expect(mobileParentPath('/parent/unknown-thing')).toBe('/m/parent/more/students');
  });

  it('窄屏（<768px）访问桌面家长页 → 跳移动版对应页（旧 token 不经登录的兜底）', () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
    renderGate('/parent/dashboard');
    expect(screen.getByTestId('m-dashboard')).toBeTruthy();
    expect(screen.queryByTestId('desktop-parent')).toBeNull();
  });

  it('窄屏访问不在 v1 范围的桌面页 → 跳对应「更多」占位', () => {
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true, writable: true });
    renderGate('/parent/rewards');
    expect(screen.getByTestId('m-more')).toBeTruthy();
  });

  it('宽屏（≥768px，iPad 横屏/PC）桌面家长台原样渲染，不跳转', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1180, configurable: true, writable: true });
    renderGate('/parent/dashboard');
    expect(screen.getByTestId('desktop-parent')).toBeTruthy();
    expect(screen.queryByTestId('m-dashboard')).toBeNull();
  });
});
