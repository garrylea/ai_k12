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
  // 终审修复波新增五页直测：各页取数端点统一静默（reject → 页面错误分支，testid 仍在）
  listMyMessages: vi.fn().mockRejectedValue(new Error('skip')),
  getUnreadMessageCount: vi.fn().mockRejectedValue(new Error('skip')),
  markMessageRead: vi.fn().mockResolvedValue(null),
  getParentGoalAttainment: vi.fn().mockRejectedValue(new Error('skip')),
  putParentGoalTarget: vi.fn().mockResolvedValue(null),
  getParentAccount: vi.fn().mockRejectedValue(new Error('skip')),
  changeParentPassword: vi.fn().mockResolvedValue(null),
  getStudentSubjectConfigs: vi.fn().mockRejectedValue(new Error('skip')),
  updateStudentSubjectConfig: vi.fn().mockResolvedValue(null),
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

  it('更多页区分真实入口与占位两组（2B 起积分/报告/对话记录转 live）', async () => {
    renderAt('/m/parent/more');
    expect(await screen.findByTestId('more-live-students')).toBeTruthy();
    expect(screen.getByTestId('more-live-messages')).toBeTruthy();
    expect(screen.getByTestId('more-live-goals')).toBeTruthy();
    expect(screen.getByTestId('more-live-account')).toBeTruthy();
    expect(screen.getByTestId('more-live-points')).toBeTruthy();
    expect(screen.getByTestId('more-live-report')).toBeTruthy();
    expect(screen.getByTestId('more-live-chat-logs')).toBeTruthy();
    expect(screen.getByTestId('more-stub-subscription')).toBeTruthy();
    expect(screen.queryByTestId('more-stub-points')).toBeNull();
    expect(screen.queryByTestId('more-stub-report')).toBeNull();
    expect(screen.queryByTestId('more-stub-chat-logs')).toBeNull();
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

  // 终审修复波 M-7：2A 五页经真实 routeTable 直达（钉住路径 → 页面映射，不经 UI 入口）
  it('messages 直达消息中心', async () => {
    renderAt('/m/parent/messages');
    expect(await screen.findByTestId('mobile-page-messages')).toBeTruthy();
  });

  it('students 直达学生管理', async () => {
    renderAt('/m/parent/students');
    expect(await screen.findByTestId('mobile-page-students')).toBeTruthy();
  });

  it('goals 直达学习目标', async () => {
    renderAt('/m/parent/goals');
    expect(await screen.findByTestId('mobile-page-goals')).toBeTruthy();
  });

  it('account 直达账号设置', async () => {
    renderAt('/m/parent/account');
    expect(await screen.findByTestId('mobile-page-account')).toBeTruthy();
  });

  it('students/7/config 直达学习配置页', async () => {
    renderAt('/m/parent/students/7/config');
    expect(await screen.findByTestId('mobile-page-config')).toBeTruthy();
  });

  // 2B 三页先以占位空壳上线（Task 2–4 替换为真实现），路径 → 页面映射先钉住
  it('points 直达积分与兑换占位页', async () => {
    renderAt('/m/parent/points');
    expect(await screen.findByTestId('mobile-page-points')).toBeTruthy();
  });

  it('report 直达学习报告占位页', async () => {
    renderAt('/m/parent/report');
    expect(await screen.findByTestId('mobile-page-report')).toBeTruthy();
  });

  it('chat-logs 直达 AI 对话记录占位页', async () => {
    renderAt('/m/parent/chat-logs');
    expect(await screen.findByTestId('mobile-page-chatlogs')).toBeTruthy();
  });
});
