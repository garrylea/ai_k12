import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminNav } from './AdminNav';
import { listBillingClaims } from '@/services/api';
import { useAdminBillingBadgeStore } from '@/store/adminBillingBadgeStore';

/**
 * 管理端侧栏回归（订阅批④补丁 Task 6）：
 * 「订阅裁决」红点走 adminBillingBadgeStore 联动 —— AdminBillingPage 裁决后主动 refresh，
 * 本组件挂载时也拉一次；不再有「切页重挂自然刷新」的错误假设（AdminNav 在 router 之外，不重挂）。
 *
 * 口径钉子：
 * - 渲染条件不变：pendingCount !== null 且 > 0 才出角标；>99 显示 '99+'。
 * - refresh 失败静默：reject 不抛、旧值保留、导航永不因计费接口故障不可用。
 * - store 是模块单例：每用例前重置 pendingCount，防跨用例泄漏。
 */

vi.mock('@/services/api', () => ({ listBillingClaims: vi.fn() }));

const listClaimsMock = vi.mocked(listBillingClaims);

beforeEach(() => {
  listClaimsMock.mockReset();
  useAdminBillingBadgeStore.setState({ pendingCount: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAdminBillingBadgeStore.setState({ pendingCount: null });
});

function renderNav() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <AdminNav />
    </MemoryRouter>,
  );
}

describe('AdminNav 订阅裁决角标（store 联动）', () => {
  it('store.pendingCount=3 → 角标文本 3（api mock 成 reject，隔离挂载 refresh 的干扰）', async () => {
    listClaimsMock.mockRejectedValue(new Error('隔离：refresh 静默失败'));
    act(() => {
      useAdminBillingBadgeStore.setState({ pendingCount: 3 });
    });

    renderNav();

    await waitFor(() => {
      expect(listClaimsMock).toHaveBeenCalledWith('pending_review', 1, 1);
    });
    // refresh reject → 静默保留 store 里手工 set 的 3
    expect(screen.getByTestId('billing-pending-badge')).toHaveTextContent('3');
    expect(useAdminBillingBadgeStore.getState().pendingCount).toBe(3);
  });

  it('pendingCount=null / 0 → 不渲染角标', () => {
    renderNav();
    expect(screen.queryByTestId('billing-pending-badge')).not.toBeInTheDocument();

    act(() => {
      useAdminBillingBadgeStore.setState({ pendingCount: 0 });
    });
    expect(screen.queryByTestId('billing-pending-badge')).not.toBeInTheDocument();
  });

  it('挂载触发 refresh：listBillingClaims("pending_review",1,1) 结果写入 store；再挂载遇 reject → 静默不抛、旧值保留', async () => {
    listClaimsMock.mockResolvedValueOnce({ items: [], total: 7, page: 1, pageSize: 1 });
    const first = renderNav();

    await waitFor(() => {
      expect(useAdminBillingBadgeStore.getState().pendingCount).toBe(7);
    });
    expect(listClaimsMock).toHaveBeenCalledWith('pending_review', 1, 1);
    expect(screen.getByTestId('billing-pending-badge')).toHaveTextContent('7');

    first.unmount();
    listClaimsMock.mockRejectedValueOnce(new Error('计费接口故障'));
    renderNav();

    await waitFor(() => {
      expect(listClaimsMock).toHaveBeenCalledTimes(2);
    });
    expect(useAdminBillingBadgeStore.getState().pendingCount).toBe(7);
    expect(screen.getByTestId('billing-pending-badge')).toHaveTextContent('7');
  });

  it('pendingCount>99 → 角标显示 99+', async () => {
    listClaimsMock.mockRejectedValue(new Error('隔离：refresh 静默失败'));
    act(() => {
      useAdminBillingBadgeStore.setState({ pendingCount: 120 });
    });

    renderNav();

    expect(await screen.findByTestId('billing-pending-badge')).toHaveTextContent('99+');
  });
});
