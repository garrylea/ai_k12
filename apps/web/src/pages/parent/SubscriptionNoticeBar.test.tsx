import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SubscriptionNoticeBar from './SubscriptionNoticeBar';
import AlertBanner from '@/components/business/AlertBanner';
import { getSubscriptionStatus, type SubscriptionStatusView } from '@/services/api';

/**
 * 订阅提示条回归（订阅批③ Task 4）：
 * 三态（expired 红 / 临期黄 / 正常不渲染）+ 拉取失败静默 + 整条点击跳订阅中心。
 * 护栏：与 AlertBanner 是**两个独立组件**——预警=孩子行为，订阅=付费状态，
 * 防后人把两者合并成「同一组件的两种文案」。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getSubscriptionStatus: vi.fn(),
  };
});

const statusMock = vi.mocked(getSubscriptionStatus);

function statusOf(over: Partial<SubscriptionStatusView> = {}): SubscriptionStatusView {
  return {
    status: 'active',
    planCode: 'monthly',
    trialEndsAt: null,
    currentPeriodEnd: '2026-10-15T00:00:00.000Z',
    daysRemaining: 12,
    source: 'order',
    ...over,
  };
}

function renderBar() {
  return render(
    <MemoryRouter initialEntries={['/parent/overview']}>
      <Routes>
        <Route path="/parent/overview" element={<SubscriptionNoticeBar />} />
        <Route path="/parent/subscription" element={<div>订阅中心页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  statusMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SubscriptionNoticeBar', () => {
  it('护栏：与 AlertBanner 是两个独立组件，不是同一组件的两种文案', () => {
    expect(SubscriptionNoticeBar).not.toBe(AlertBanner);
  });

  it('expired → 红条「订阅已过期，学生端已锁定，请续费」', async () => {
    statusMock.mockResolvedValue(statusOf({ status: 'expired', daysRemaining: 0 }));
    renderBar();
    const bar = await screen.findByTestId('subscription-notice-bar');
    expect(bar).toHaveTextContent('订阅已过期，学生端已锁定，请续费');
    expect(bar.className).toContain('var(--error)');
  });

  it('临期（daysRemaining <= 7 且非 expired）→ 黄条「订阅即将到期，剩余 N 天」', async () => {
    statusMock.mockResolvedValue(statusOf({ status: 'active', daysRemaining: 5 }));
    renderBar();
    const bar = await screen.findByTestId('subscription-notice-bar');
    expect(bar).toHaveTextContent('订阅即将到期，剩余 5 天');
    expect(bar.className).toContain('var(--warning)');
  });

  it('临期边界：daysRemaining = 7 渲染，= 8 不渲染', async () => {
    statusMock.mockResolvedValue(statusOf({ status: 'active', daysRemaining: 7 }));
    const { unmount } = renderBar();
    expect(await screen.findByTestId('subscription-notice-bar')).toBeInTheDocument();
    unmount();

    statusMock.mockResolvedValue(statusOf({ status: 'active', daysRemaining: 8 }));
    renderBar();
    await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('subscription-notice-bar')).not.toBeInTheDocument();
  });

  it('正常（active 且天数富余）→ 不渲染', async () => {
    statusMock.mockResolvedValue(statusOf({ status: 'active', daysRemaining: 12 }));
    renderBar();
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(screen.queryByTestId('subscription-notice-bar')).not.toBeInTheDocument();
  });

  it('trialing 且天数富余 → 不渲染', async () => {
    statusMock.mockResolvedValue(statusOf({ status: 'trialing', daysRemaining: 20 }));
    renderBar();
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(screen.queryByTestId('subscription-notice-bar')).not.toBeInTheDocument();
  });

  it('拉取失败 → 静默不渲染（提示条永不阻断家长端）', async () => {
    statusMock.mockRejectedValue(new Error('network down'));
    renderBar();
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(screen.queryByTestId('subscription-notice-bar')).not.toBeInTheDocument();
  });

  it('点击整条 → 跳 /parent/subscription', async () => {
    statusMock.mockResolvedValue(statusOf({ status: 'expired', daysRemaining: 0 }));
    renderBar();
    fireEvent.click(await screen.findByTestId('subscription-notice-bar'));
    expect(await screen.findByText('订阅中心页')).toBeInTheDocument();
  });
});
