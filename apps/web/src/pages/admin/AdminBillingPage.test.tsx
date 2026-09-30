import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminBillingPage from './AdminBillingPage';
import {
  approveBillingClaim,
  grantFamilyDays,
  listBillingClaims,
  listBillingFamilies,
  rejectBillingClaim,
  setFamilyTrial,
  type AdminBillingClaimView,
  type AdminFamilyView,
  type SubscriptionStatusView,
} from '@/services/api';
import { toast } from '@/components/base';

/**
 * 管理端「订阅裁决」页回归（订阅批④ Task 7）：
 * Tab 1 待裁决（列表 / 刷新 / 通过 / 驳回带原因）、Tab 2 家庭订阅（搜索 / 调整试用 / 赠送扣减天数）。
 *
 * 口径钉子：
 * - 「现场核验」= 行内「刷新」+ 以渠道状态为准的提示，**不调任何家长端点**（无 admin 订单详情端点，本期不新增）。
 * - approve / reject 成功后重拉列表（行消失由重拉体现），角标归 AdminNav 自己的拉取，本页不负责。
 * - 调整试用 / 赠送天数成功后用返回的 StatusView **行内更新**，不整页重拉。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listBillingClaims: vi.fn(),
    approveBillingClaim: vi.fn(),
    rejectBillingClaim: vi.fn(),
    listBillingFamilies: vi.fn(),
    setFamilyTrial: vi.fn(),
    grantFamilyDays: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const listClaimsMock = vi.mocked(listBillingClaims);
const approveMock = vi.mocked(approveBillingClaim);
const rejectMock = vi.mocked(rejectBillingClaim);
const listFamiliesMock = vi.mocked(listBillingFamilies);
const setTrialMock = vi.mocked(setFamilyTrial);
const grantMock = vi.mocked(grantFamilyDays);
const toastMock = vi.mocked(toast);

function claimOf(over: Partial<AdminBillingClaimView> = {}): AdminBillingClaimView {
  return {
    orderNo: 'NO1',
    parentPhone: '13800000001',
    planName: '月度会员',
    amountCents: 3900,
    claimStatus: 'pending_review',
    claimedAt: '2026-09-30T02:00:00.000Z',
    claimNote: '微信转账 39 元，请核实',
    paymentStatus: 'pending',
    ...over,
  };
}

function familyOf(over: Partial<AdminFamilyView> = {}): AdminFamilyView {
  return {
    parentId: 11,
    phone: '13900000001',
    studentCount: 2,
    status: 'trialing',
    planCode: null,
    trialEndsAt: '2026-10-15T00:00:00.000Z',
    currentPeriodEnd: null,
    ...over,
  };
}

function statusViewOf(over: Partial<SubscriptionStatusView> = {}): SubscriptionStatusView {
  return {
    status: 'trialing',
    planCode: null,
    trialEndsAt: '2026-11-15T00:00:00.000Z',
    currentPeriodEnd: null,
    daysRemaining: 46,
    source: 'trial',
    ...over,
  };
}

function claimPage(items: AdminBillingClaimView[]) {
  return { items, total: items.length, page: 1, pageSize: 20 };
}

beforeEach(() => {
  listClaimsMock.mockReset().mockResolvedValue(claimPage([claimOf()]));
  approveMock.mockReset();
  rejectMock.mockReset().mockResolvedValue({ orderNo: 'NO1', claimStatus: 'rejected' });
  listFamiliesMock.mockReset().mockResolvedValue({
    items: [familyOf()],
    total: 1,
    page: 1,
    pageSize: 20,
  });
  setTrialMock.mockReset();
  grantMock.mockReset();
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AdminBillingPage Tab 1 待裁决', () => {
  it('渲染 claim 列表：家长手机号 / 套餐 / 金额 / 主张时间 / 备注，不调任何家长端点', async () => {
    render(<AdminBillingPage />);

    const row = await screen.findByTestId('claim-row-NO1');
    expect(within(row).getByText('13800000001')).toBeInTheDocument();
    expect(within(row).getByText(/月度会员/)).toBeInTheDocument();
    expect(within(row).getByText(/¥39\.00/)).toBeInTheDocument();
    expect(within(row).getByText(/微信转账 39 元，请核实/)).toBeInTheDocument();
    // 角标数据来自 AdminNav，页面本身只拉 claims 列表（status 缺省 pending_review 由后端定，但前端显式传）
    expect(listClaimsMock).toHaveBeenCalledWith('pending_review', 1, 20);
    expect(listFamiliesMock).not.toHaveBeenCalled();
  });

  it('列表为空 → 空态提示，不渲染任何行', async () => {
    listClaimsMock.mockResolvedValue(claimPage([]));

    render(<AdminBillingPage />);

    expect(await screen.findByTestId('claims-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('claim-row-NO1')).not.toBeInTheDocument();
  });

  it('点「刷新」→ 重拉列表并提示以渠道状态为准（不调家长订单详情端点）', async () => {
    render(<AdminBillingPage />);
    const row = await screen.findByTestId('claim-row-NO1');
    const loadsBefore = listClaimsMock.mock.calls.length;

    fireEvent.click(within(row).getByRole('button', { name: '刷新' }));

    await waitFor(() => {
      expect(listClaimsMock.mock.calls.length).toBeGreaterThan(loadsBefore);
    });
    expect(toastMock).toHaveBeenCalledWith('info', '以渠道支付状态为准，请线下核实到账');
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('点「通过」→ approve(orderNo) + toast + 重拉列表（行消失由重拉体现）', async () => {
    approveMock.mockResolvedValue({ orderNo: 'NO1', paymentStatus: 'paid', result: 'paid' });
    render(<AdminBillingPage />);
    const row = await screen.findByTestId('claim-row-NO1');
    const loadsBefore = listClaimsMock.mock.calls.length;

    fireEvent.click(within(row).getByRole('button', { name: '通过' }));

    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('NO1'));
    expect(toastMock).toHaveBeenCalledWith('success', '已入账并开通订阅');
    await waitFor(() => {
      expect(listClaimsMock.mock.calls.length).toBeGreaterThan(loadsBefore);
    });
  });

  it('点「驳回」→ 弹原因表单；确认 → reject(orderNo, reason) + 重拉', async () => {
    render(<AdminBillingPage />);
    const row = await screen.findByTestId('claim-row-NO1');

    fireEvent.click(within(row).getByRole('button', { name: '驳回' }));

    // 只是打开表单，还没发请求
    expect(rejectMock).not.toHaveBeenCalled();
    const input = await screen.findByTestId('reject-reason-input');
    fireEvent.change(input, { target: { value: '未查到对应到账' } });
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }));

    await waitFor(() => {
      expect(rejectMock).toHaveBeenCalledWith('NO1', '未查到对应到账');
    });
    expect(toastMock).toHaveBeenCalledWith('success', '已驳回');
  });

  it('approve 失败 → toast("error")，列表不重拉', async () => {
    approveMock.mockRejectedValue(new Error('订单已入账'));
    render(<AdminBillingPage />);
    const row = await screen.findByTestId('claim-row-NO1');
    const loadsBefore = listClaimsMock.mock.calls.length;

    fireEvent.click(within(row).getByRole('button', { name: '通过' }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith('error', '订单已入账');
    });
    expect(listClaimsMock.mock.calls.length).toBe(loadsBefore);
  });
});

describe('AdminBillingPage Tab 2 家庭订阅', () => {
  async function openFamiliesTab() {
    render(<AdminBillingPage />);
    fireEvent.click(await screen.findByTestId('tab-families'));
    await screen.findByTestId('family-row-11');
  }

  it('切到家庭 Tab → 拉家庭列表，行内展示手机号 / 孩子数 / 状态 / 试用截止', async () => {
    await openFamiliesTab();

    const row = screen.getByTestId('family-row-11');
    expect(within(row).getByText('13900000001')).toBeInTheDocument();
    expect(within(row).getByText(/2 个孩子/)).toBeInTheDocument();
    expect(within(row).getByText(/试用中/)).toBeInTheDocument();
    expect(listFamiliesMock).toHaveBeenCalledWith('', 1, 20);
  });

  it('搜索 → keyword 透传给列表端点', async () => {
    await openFamiliesTab();

    fireEvent.change(screen.getByTestId('family-search-input'), { target: { value: '139' } });
    fireEvent.click(screen.getByTestId('family-search-btn'));

    await waitFor(() => {
      expect(listFamiliesMock).toHaveBeenLastCalledWith('139', 1, 20);
    });
  });

  it('调整试用：选日期 → setFamilyTrial(parentId, ISO)，成功后行内 StatusView 更新', async () => {
    setTrialMock.mockResolvedValue(statusViewOf());
    await openFamiliesTab();

    fireEvent.click(within(screen.getByTestId('family-row-11')).getByRole('button', { name: '调整试用' }));
    const input = await screen.findByTestId('trial-date-input');
    fireEvent.change(input, { target: { value: '2026-11-15' } });
    fireEvent.click(screen.getByTestId('trial-save-btn'));

    await waitFor(() => {
      expect(setTrialMock).toHaveBeenCalledTimes(1);
    });
    const [parentId, iso] = setTrialMock.mock.calls[0];
    expect(parentId).toBe(11);
    // 当天整天有效：落到 11-15 的本地当天内（ISO 可解析且日期部分正确）
    expect(new Date(iso as string).toISOString().slice(0, 10)).toBe('2026-11-15');
    // 行内更新：试用截止换成了 StatusView 里的新值
    expect(await screen.findByText(/2026-11-15/)).toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith('success', '试用截止已更新');
  });

  it('调整试用：点「收回」→ setFamilyTrial(parentId, null)', async () => {
    setTrialMock.mockResolvedValue(statusViewOf({ trialEndsAt: null, status: 'expired', daysRemaining: 0 }));
    await openFamiliesTab();

    fireEvent.click(within(screen.getByTestId('family-row-11')).getByRole('button', { name: '调整试用' }));
    fireEvent.click(await screen.findByTestId('trial-revoke-btn'));

    await waitFor(() => {
      expect(setTrialMock).toHaveBeenCalledWith(11, null);
    });
  });

  it('赠送/扣减天数：填天数与原因 → grantFamilyDays(parentId, days, reason)，行内更新', async () => {
    grantMock.mockResolvedValue(
      statusViewOf({
        status: 'active',
        planCode: 'monthly',
        currentPeriodEnd: '2026-10-30T00:00:00.000Z',
        source: 'order',
      }),
    );
    await openFamiliesTab();

    fireEvent.click(within(screen.getByTestId('family-row-11')).getByRole('button', { name: '赠送 / 扣减' }));
    fireEvent.change(await screen.findByTestId('grant-days-input'), { target: { value: '7' } });
    fireEvent.change(screen.getByTestId('grant-reason-input'), { target: { value: '客诉补偿' } });
    fireEvent.click(screen.getByTestId('grant-submit-btn'));

    await waitFor(() => {
      expect(grantMock).toHaveBeenCalledWith(11, 7, '客诉补偿');
    });
    expect(toastMock).toHaveBeenCalledWith('success', '已调整 7 天');
  });

  it('grant days 为空 / 0 → 前端拦下不发请求', async () => {
    await openFamiliesTab();

    fireEvent.click(within(screen.getByTestId('family-row-11')).getByRole('button', { name: '赠送 / 扣减' }));
    fireEvent.change(await screen.findByTestId('grant-days-input'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('grant-submit-btn'));

    expect(grantMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith('error', '天数必须是非 0 整数');
  });

  it('setFamilyTrial 失败 → toast("error")，弹层不关', async () => {
    setTrialMock.mockRejectedValue(new Error('家长不存在'));
    await openFamiliesTab();

    fireEvent.click(within(screen.getByTestId('family-row-11')).getByRole('button', { name: '调整试用' }));
    fireEvent.change(await screen.findByTestId('trial-date-input'), { target: { value: '2026-11-15' } });
    fireEvent.click(screen.getByTestId('trial-save-btn'));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith('error', '家长不存在');
    });
    expect(screen.getByTestId('trial-date-input')).toBeInTheDocument();
  });
});
