import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from './routeTable';
import {
  getMyLedger,
  getMyPoints,
  getMyRewards,
  type MyPoints,
  type MyRewards,
  type PointLedgerPage,
} from '@/services/api';

/**
 * 路由级回归（计划 §3 Task 8）。
 *
 * 目的：钉住「路径 → 真页面」这层映射，而不是只测页面组件本身。
 * Task 5 把 `/student/profile`、`/student/rewards` 的 `Placeholder` 换成了真页面；
 * 这两个页面各自有组件测试，但**没有任何测试证明路由表指向它们**——一个手误改回
 * `Placeholder` 或改错路径，组件测试全绿也发现不了，所以这里挂载**真实路由表**跑一遍。
 *
 * 挂载方式：`createMemoryRouter(routes)`——用的是 `routeTable.tsx` 导出的同一份
 * 真实路由表（不是另抄一棵等价子树），否则测的还是影子配置。
 * `index.tsx` 只是浏览器 router 引导层，唯一真源在 `routeTable.tsx`。
 *
 * 鉴权：`/student/*` 在 `RequireRole role="student"` 之下，测试**按真实口径 stub 登录态**
 * （localStorage 的 `token`/`userRole` + 未过期的 exp），并额外验证无 token / 角色不符
 * 会被挡回登录页——不为了好测而放宽守卫。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getMyPoints: vi.fn(),
    getMyLedger: vi.fn(),
    getMyRewards: vi.fn(),
  };
});

const getMyPointsMock = vi.mocked(getMyPoints);
const getMyLedgerMock = vi.mocked(getMyLedger);
const getMyRewardsMock = vi.mocked(getMyRewards);

const PLACEHOLDER_TEXT = '原型占位：此页面正在设计中...';

const POINTS: MyPoints = {
  balance: 120,
  totalEarned: 520,
  todayEarned: 10,
  level: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
  nextLevel: { code: 'qingtong', name: '青铜', index: 2, threshold: 1200 },
  pointsToNextLevel: 680,
  progressPercent: 2,
};

const LEDGER: PointLedgerPage = {
  items: [
    {
      id: 1,
      kind: 'earn',
      title: '数学专项 · 3 题',
      points: 8,
      createdAt: '2026-09-17T10:30:00.000Z',
      refType: 'training_session',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};

const REWARDS: MyRewards = {
  balance: 120,
  level: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
  items: [
    {
      id: 1,
      name: '看一集动画',
      description: null,
      pointsCost: 100,
      minLevelCode: null,
      minLevelName: null,
      affordable: true,
      levelOk: true,
      gap: 0,
    },
  ],
};

/** 造一个 exp 在未来的假 JWT：`isSessionValid()` 解 payload 校 exp，不是只看字符串存在。 */
function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

function setStudentSession() {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'student');
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  getMyPointsMock.mockReset();
  getMyLedgerMock.mockReset();
  getMyRewardsMock.mockReset();
});

describe('路由表：积分相关页面', () => {
  it('/student/profile 渲染 ProfilePage，而非 Placeholder', async () => {
    setStudentSession();
    getMyPointsMock.mockResolvedValue(POINTS);
    getMyLedgerMock.mockResolvedValue(LEDGER);

    renderAt('/student/profile');

    // 真页面内容：段位大卡（标题与图标都来自 ProfilePage 自身，占位页不可能有）
    expect(await screen.findByRole('heading', { name: '个人中心' })).toBeInTheDocument();
    expect(await screen.findByTestId('profile-level-icon')).toBeInTheDocument();
    expect(screen.getByText('还差 680 分')).toBeInTheDocument();

    expect(screen.queryByText(PLACEHOLDER_TEXT)).not.toBeInTheDocument();
    // 挂在 StudentLayout 下（跟随主题、有侧栏导航），不是全屏页
    expect(document.querySelector('.student-theme-container')).not.toBeNull();
    // 侧栏两项都在且指向正确路径（导航与路由是两条独立的线，得各钉各的）
    expect(screen.getByRole('link', { name: '奖励册' })).toHaveAttribute(
      'href',
      '/student/rewards',
    );
    expect(screen.getByRole('link', { name: '个人中心' })).toHaveAttribute(
      'href',
      '/student/profile',
    );
  });

  it('/student/rewards 渲染 RewardsPage（含「找家长兑换」），而非 Placeholder', async () => {
    setStudentSession();
    getMyRewardsMock.mockResolvedValue(REWARDS);

    renderAt('/student/rewards');

    expect(await screen.findByRole('heading', { name: '奖励册' })).toBeInTheDocument();
    expect(await screen.findByText('找家长兑换')).toBeInTheDocument();
    expect(screen.getByTestId('reward-card-1')).toBeInTheDocument();

    expect(screen.queryByText(PLACEHOLDER_TEXT)).not.toBeInTheDocument();
    expect(document.querySelector('.student-theme-container')).not.toBeNull();
  });

  it('其余占位路由仍渲染 Placeholder（证明 Placeholder 未被误删/误改）', () => {
    renderAt('/student/auxiliary/selector');

    expect(screen.getByText(PLACEHOLDER_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '知识点选择器 P3.2' })).toBeInTheDocument();
  });
});

describe('路由表：RequireRole 守卫未被放宽', () => {
  it('无 token 访问 /student/profile → 回登录页，不发积分请求', async () => {
    localStorage.clear();

    renderAt('/student/profile');

    expect(await screen.findByRole('heading', { name: '智学系统' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '个人中心' })).not.toBeInTheDocument();
    expect(getMyPointsMock).not.toHaveBeenCalled();
  });

  it('角色不符（parent 拿学生路径）→ 回登录页', async () => {
    localStorage.setItem('token', validToken());
    localStorage.setItem('userRole', 'parent');

    renderAt('/student/profile');

    expect(await screen.findByRole('heading', { name: '智学系统' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '个人中心' })).not.toBeInTheDocument();
    expect(getMyPointsMock).not.toHaveBeenCalled();
  });
});
