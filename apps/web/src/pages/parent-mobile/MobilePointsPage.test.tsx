import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import MobilePointsPage from './MobilePointsPage';
import { useParentStudentStore } from '@/store/parentStudentStore';

// store 初始（persist 后）studentId 是 null，页面在 null 时渲染「先选择孩子」空态——
// 所有用例都假定「正在看孩子 1」，进页前统一置 1
beforeEach(() => {
  useParentStudentStore.setState({ studentId: 1 });
});

afterEach(() => {
  cleanup();
  useParentStudentStore.setState({ studentId: 1 });
});

const points = {
  balance: 500,
  totalEarned: 1200,
  todayEarned: 10,
  level: { code: 'qingtong', name: '青铜' },
  nextLevel: { code: 'baiyin', name: '白银' },
  pointsToNextLevel: 800,
  progressPercent: 58,
};

vi.mock('@/services/api', () => ({ getParentPoints: vi.fn() }));

// 面板组件 mock：本任务只测页面组装（Tab 切换 / 概览卡 / 守卫接线），面板内部逻辑有各自的测试
vi.mock('@/pages/parent/points/PointRulesPanel', () => ({
  default: () => <div data-testid="panel-rules" />,
}));

// 注册即脏：模拟家长在奖励清单有未保存草稿。注册时机与真面板同款（mount effect 注册、
// 卸载注销）；confirmLeave 命名与 RewardCatalogPanel 真源一致
vi.mock('@/pages/parent/points/RewardCatalogPanel', async () => {
  const { useEffect } = await import('react');
  return {
    default: ({
      onRegisterLeaveGuard,
    }: {
      onRegisterLeaveGuard?: (guard: { dirty: boolean; confirmLeave: (onConfirmed: () => void) => void } | null) => void;
    }) => {
      useEffect(() => {
        onRegisterLeaveGuard?.({ dirty: true, confirmLeave: (ok) => ok() });
        return () => onRegisterLeaveGuard?.(null);
      }, [onRegisterLeaveGuard]);
      return <div data-testid="panel-catalog" />;
    },
  };
});

vi.mock('@/pages/parent/points/RedeemPanel', () => ({ default: () => <div data-testid="panel-redeem" /> }));
vi.mock('@/pages/parent/points/PointsSettingsPanel', () => ({ default: () => <div data-testid="panel-settings" /> }));
vi.mock('@/pages/parent/points/RedemptionHistoryPanel', () => ({ default: () => <div data-testid="panel-history" /> }));

import { getParentPoints } from '@/services/api';

function renderPage() {
  render(
    <MemoryRouter>
      <MobilePointsPage />
    </MemoryRouter>,
  );
}

describe('MobilePointsPage', () => {
  it('概览卡常驻 + 默认 Tab=规则 + 四个 Tab 条', async () => {
    vi.mocked(getParentPoints).mockResolvedValue(points as never);
    renderPage();
    expect(await screen.findByText(/500/)).toBeTruthy();
    expect(screen.getByText(/青铜/)).toBeTruthy();
    expect(screen.getByTestId('panel-rules')).toBeTruthy();
    for (const k of ['rules', 'catalog', 'redeem', 'history']) {
      expect(screen.getByTestId(`points-tab-${k}`)).toBeTruthy();
    }
  });

  it('切 Tab：有未保存草稿时拦截确认，确认后才切', async () => {
    vi.mocked(getParentPoints).mockResolvedValue(points as never);
    renderPage();
    await screen.findByTestId('panel-rules');
    // 先进奖励册（注册 dirty 守卫），再试图离开
    await userEvent.click(screen.getByTestId('points-tab-catalog'));
    expect(await screen.findByTestId('panel-catalog')).toBeTruthy();
    await userEvent.click(screen.getByTestId('points-tab-history'));
    // 拦截弹窗出现，history 未切换
    expect(await screen.findByTestId('points-leave-confirm')).toBeTruthy();
    expect(screen.queryByTestId('panel-history')).toBeNull();
    // ConfirmDialog 确认按钮 aria-label="确认"（仓内既有约定）
    await userEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(await screen.findByTestId('panel-history')).toBeTruthy();
  });

  it('换孩子：dirty 时同样拦截', async () => {
    vi.mocked(getParentPoints).mockResolvedValue(points as never);
    renderPage();
    await screen.findByTestId('panel-rules');
    await userEvent.click(screen.getByTestId('points-tab-catalog'));
    expect(await screen.findByTestId('panel-catalog')).toBeTruthy();
    useParentStudentStore.setState({ studentId: 2 });
    expect(await screen.findByTestId('points-leave-confirm')).toBeTruthy();
  });

  it('getParentPoints 失败显示错误重试', async () => {
    vi.mocked(getParentPoints).mockRejectedValue(new Error('x'));
    renderPage();
    expect(await screen.findByTestId('points-retry')).toBeTruthy();
  });
});
