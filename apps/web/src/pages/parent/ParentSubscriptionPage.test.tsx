import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ParentSubscriptionPage from './ParentSubscriptionPage';
import {
  ApiError,
  cancelBillingOrder,
  confirmBillingOrderPaid,
  createBillingOrder,
  getAiUsage,
  getBillingOrder,
  getSubscriptionPlans,
  getSubscriptionStatus,
  listBillingOrders,
  listUnreadBillingNotices,
  type BillingOrderView,
  type PlanView,
  type SubscriptionStatusView,
  type UsageView,
} from '@/services/api';
import { toast } from '@/components/base';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getSubscriptionStatus: vi.fn(),
    // 顶栏裁决结果条（BillingNoticeBar）挂载即拉：默认无未读 → 不渲染
    listUnreadBillingNotices: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getSubscriptionPlans: vi.fn(),
    getAiUsage: vi.fn(),
    createBillingOrder: vi.fn(),
    listBillingOrders: vi.fn(),
    getBillingOrder: vi.fn(),
    cancelBillingOrder: vi.fn(),
    confirmBillingOrderPaid: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const statusMock = vi.mocked(getSubscriptionStatus);
const noticesMock = vi.mocked(listUnreadBillingNotices);
const plansMock = vi.mocked(getSubscriptionPlans);
const usageMock = vi.mocked(getAiUsage);
const createOrderMock = vi.mocked(createBillingOrder);
const listOrdersMock = vi.mocked(listBillingOrders);
const getOrderMock = vi.mocked(getBillingOrder);
const cancelOrderMock = vi.mocked(cancelBillingOrder);
const confirmPaidMock = vi.mocked(confirmBillingOrderPaid);
const toastMock = vi.mocked(toast);

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

const PLAN: PlanView = { planCode: 'monthly', name: '月度会员', priceCents: 19800, durationDays: 30 };

function usageOf(over: Partial<UsageView> = {}): UsageView {
  return {
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-09-30T00:00:00.000Z',
    calls: 20,
    inputTokens: 1000,
    outputTokens: 2000,
    tokensUnknown: 0,
    byDay: [],
    ...over,
  };
}

function orderOf(over: Partial<BillingOrderView> = {}): BillingOrderView {
  return {
    orderNo: 'NO123',
    paymentStatus: 'pending',
    amountCents: 19800,
    planName: '月度会员',
    channel: 'wechat',
    qrContent: 'wxp://f2f0xxx',
    redirectUrl: null,
    expiresAt: '2026-09-30T09:00:00.000Z',
    paidAt: null,
    createdAt: '2026-09-30T08:00:00.000Z',
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ParentSubscriptionPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  statusMock.mockReset().mockResolvedValue(statusOf());
  // 顶栏裁决结果条挂载即拉：默认无未读 → 不渲染
  noticesMock.mockReset().mockResolvedValue({ items: [], total: 0 });
  plansMock.mockReset().mockResolvedValue([PLAN]);
  usageMock.mockReset().mockResolvedValue(usageOf());
  createOrderMock.mockReset();
  listOrdersMock.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
  getOrderMock.mockReset();
  cancelOrderMock.mockReset().mockResolvedValue(undefined);
  confirmPaidMock.mockReset();
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ParentSubscriptionPage 状态卡三态（spec §6.1）', () => {
  it('active → 「订阅生效中 · 剩余 N 天」，data-status=active，无即将到期徽标', async () => {
    renderPage();

    const card = await screen.findByTestId('subscription-status-card');
    await screen.findByText('订阅生效中 · 剩余 12 天');
    expect(card).toHaveAttribute('data-status', 'active');
    expect(screen.queryByTestId('subscription-warning-badge')).not.toBeInTheDocument();
    expect(screen.getByText('到期日期：2026-10-15')).toBeInTheDocument();
    // 右侧展示当前套餐名（planCode → plans 里的名称）；套餐卡里也有同名，故断言出现两次
    expect(screen.getAllByText('月度会员').length).toBe(2);
  });

  it('trialing → 「试用中 · 剩余 N 天」；daysRemaining≤7 加「即将到期」徽标', async () => {
    statusMock.mockResolvedValue(statusOf({ status: 'trialing', daysRemaining: 5, planCode: null }));
    renderPage();

    await screen.findByText('试用中 · 剩余 5 天');
    const card = screen.getByTestId('subscription-status-card');
    expect(card).toHaveAttribute('data-status', 'trialing');
    expect(screen.getByTestId('subscription-warning-badge')).toHaveTextContent('即将到期');
    // 没有当前套餐时不渲染套餐名区域
    expect(screen.queryByText('当前套餐')).not.toBeInTheDocument();
  });

  it('expired → 「已过期」，data-status=expired，不加即将到期徽标', async () => {
    statusMock.mockResolvedValue(statusOf({ status: 'expired', daysRemaining: 0 }));
    renderPage();

    await screen.findByText('已过期');
    expect(screen.getByTestId('subscription-status-card')).toHaveAttribute('data-status', 'expired');
    expect(screen.queryByTestId('subscription-warning-badge')).not.toBeInTheDocument();
  });

  it('首屏加载失败 → 错误卡 + 重试', async () => {
    statusMock.mockRejectedValueOnce(new ApiError(5000, '服务异常'));

    renderPage();
    expect(await screen.findByTestId('subscription-error')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('subscription-status-card')).toBeInTheDocument();
  });
});

describe('ParentSubscriptionPage 套餐与用量', () => {
  it('套餐卡渲染价格：19800 → ¥198，选中态 data-selected', async () => {
    renderPage();

    const card = await screen.findByTestId('plan-card-monthly');
    expect(card).toHaveTextContent('¥198');
    expect(card).toHaveTextContent('月度会员');
    expect(card).toHaveTextContent('有效期 30 天');
    // 默认选中第一个套餐
    expect(card).toHaveAttribute('data-selected', 'true');
  });

  it('用量卡渲染 calls/tokens；tokensUnknown>0 显式注明「量不到 tokens，未计入」', async () => {
    usageMock.mockResolvedValue(usageOf({ calls: 48, inputTokens: 12000, outputTokens: 34000, tokensUnknown: 3 }));
    renderPage();

    await screen.findByTestId('usage-card');
    expect(screen.getByText('48 次')).toBeInTheDocument();
    expect(screen.getByText('12000')).toBeInTheDocument();
    expect(screen.getByText('34000')).toBeInTheDocument();
    expect(screen.getByTestId('usage-unknown')).toHaveTextContent(
      '其中 3 次调用量不到 tokens，未计入',
    );
  });

  it('tokensUnknown=0 → 不渲染注记', async () => {
    renderPage();

    await screen.findByTestId('usage-card');
    expect(screen.queryByTestId('usage-unknown')).not.toBeInTheDocument();
  });
});

describe('ParentSubscriptionPage 下单与支付弹层', () => {
  it('下单成功 → paying 弹层画二维码；轮询到 paid → success 文案并重拉状态', async () => {
    createOrderMock.mockResolvedValue(orderOf());
    // 轮询（进入 paying 即查一次）返回已支付
    getOrderMock.mockResolvedValue(orderOf({ paymentStatus: 'paid', paidAt: '2026-09-30T08:01:00.000Z' }));

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '续费' }));

    // 弹层 + 二维码
    expect(await screen.findByTestId('pay-qr')).toBeInTheDocument();
    expect(createOrderMock).toHaveBeenCalledWith('monthly', 'wechat');

    // 轮询查到 paid → success 视图
    expect(await screen.findByTestId('subscription-success')).toBeInTheDocument();
    expect(screen.getByText('支付成功')).toBeInTheDocument();
    // 展示重拉后的新到期时间
    expect(screen.getByText('新的到期日期：2026-10-15')).toBeInTheDocument();
    await waitFor(() => expect(getOrderMock).toHaveBeenCalledWith('NO123'));
    // paid 后重拉了订阅状态（首屏 1 次 + paid 后 1 次）
    await waitFor(() => expect(statusMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('下单响应无 qrContent → 首次轮询回填订单详情后画出二维码', async () => {
    // 真实后端 POST /api/billing/orders 视图不含 qrContent（spec：凭证来自 GET 订单详情）
    createOrderMock.mockResolvedValue(orderOf({ qrContent: undefined }));
    getOrderMock.mockResolvedValue(orderOf()); // pending + qrContent

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '续费' }));

    expect(await screen.findByTestId('pay-qr')).toBeInTheDocument();
    expect(getOrderMock).toHaveBeenCalledWith('NO123');
  });

  it('redirectUrl 非空 → 「跳转支付宝支付」按钮，点击 window.open', async () => {
    createOrderMock.mockResolvedValue(orderOf({ qrContent: null, redirectUrl: 'https://openapi.alipay.com/pay?x=1' }));
    // 轮询一直 pending，弹层停留
    getOrderMock.mockResolvedValue(orderOf({ qrContent: null, redirectUrl: 'https://openapi.alipay.com/pay?x=1' }));
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '续费' }));

    const jump = await screen.findByRole('button', { name: '跳转支付宝支付' });
    expect(screen.queryByTestId('pay-qr')).not.toBeInTheDocument();
    fireEvent.click(jump);
    expect(openSpy).toHaveBeenCalledWith('https://openapi.alipay.com/pay?x=1', '_blank', 'noopener,noreferrer');
  });

  it('弹层「我已付款」→ confirm 成功进 success', async () => {
    createOrderMock.mockResolvedValue(orderOf());
    // 轮询始终 pending，只能走「我已付款」兜底
    getOrderMock.mockResolvedValue(orderOf());

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '续费' }));
    await screen.findByTestId('pay-qr');

    confirmPaidMock.mockResolvedValueOnce({ orderNo: 'NO123', paymentStatus: 'paid' });
    fireEvent.click(screen.getByRole('button', { name: '我已付款' }));
    expect(await screen.findByTestId('subscription-success')).toBeInTheDocument();
  });

  it('2002（已有进行中订单）→ 「已有待支付订单」文案并展开刷新订单历史', async () => {
    createOrderMock.mockRejectedValue(new ApiError(2002, '已有进行中订单，请先取消或等待超时'));

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '续费' }));

    expect(await screen.findByTestId('subscription-create-error')).toHaveTextContent(
      '已有待支付订单，请先在订单历史中取消',
    );
    // 订单历史被自动展开并刷新
    expect(await screen.findByTestId('order-history')).toBeInTheDocument();
    expect(listOrdersMock).toHaveBeenCalledWith(1, 10);
  });

  it('订单历史 pending 行取消 → cancelBillingOrder 被调、列表重拉', async () => {
    listOrdersMock
      .mockResolvedValueOnce({
        items: [orderOf({ orderNo: 'NO1', paymentStatus: 'pending' })],
        total: 1,
        page: 1,
        pageSize: 10,
      })
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });

    renderPage();
    await screen.findByTestId('subscription-status-card');
    fireEvent.click(screen.getByTestId('order-history-toggle'));
    const row = await screen.findByTestId('order-row-NO1');

    fireEvent.click(within(row).getByRole('button', { name: '取消' }));

    await waitFor(() => expect(cancelOrderMock).toHaveBeenCalledWith('NO1'));
    // 列表重拉（第 1 次展开 + 取消后刷新）
    await waitFor(() => expect(listOrdersMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText('暂无订单')).toBeInTheDocument();
  });

  it('弹层「取消订单」→ cancelBillingOrder 后回 ready，弹层关闭', async () => {
    createOrderMock.mockResolvedValue(orderOf());
    getOrderMock.mockResolvedValue(orderOf());

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '续费' }));
    await screen.findByTestId('pay-qr');

    fireEvent.click(screen.getByRole('button', { name: '取消订单' }));

    await waitFor(() => expect(cancelOrderMock).toHaveBeenCalledWith('NO123'));
    await waitFor(() => expect(screen.queryByTestId('pay-modal')).not.toBeInTheDocument());
  });
});

describe('ParentSubscriptionPage 支付弹层裁决三态与线下转账（批④ Task 6）', () => {
  it('渠道三选含「线下转账」；选它下单 → createBillingOrder 收到 manual，弹层无二维码、显示转账指引与必填备注框', async () => {
    createOrderMock.mockResolvedValue(orderOf({ channel: 'manual', qrContent: null }));
    // 轮询：manual 单无凭证，保持 pending
    getOrderMock.mockResolvedValue(orderOf({ channel: 'manual', qrContent: null }));

    renderPage();
    fireEvent.click(await screen.findByLabelText('线下转账'));
    fireEvent.click(await screen.findByRole('button', { name: '续费' }));

    expect(createOrderMock).toHaveBeenCalledWith('monthly', 'manual');
    expect(await screen.findByTestId('pay-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('pay-qr')).not.toBeInTheDocument();
    expect(screen.getByTestId('pay-manual-guide')).toHaveTextContent(
      '请联系管理员付款（个人微信转账），付款后填写转账备注并点击我已付款',
    );

    // 备注必填：空 → 「我已付款」禁用；填写 → 点亮并透传 note
    const confirmBtn = screen.getByRole('button', { name: '我已付款' });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(screen.getByTestId('pay-note'), { target: { value: '微信号 xx 已转 198 元' } });
    expect(confirmBtn).toBeEnabled();
    confirmPaidMock.mockRejectedValueOnce(
      new ApiError(2004, '渠道尚未确认，已转人工核实', undefined, 400, 'pending_review'),
    );
    fireEvent.click(confirmBtn);
    await waitFor(() =>
      expect(confirmPaidMock).toHaveBeenCalledWith('NO123', '微信号 xx 已转 198 元'),
    );
  });

  it('confirm 2004（错误体带 claimStatus=pending_review）→ 「已转人工核实」提示 + 「我已付款」停用，弹层停留', async () => {
    createOrderMock.mockResolvedValue(orderOf());
    getOrderMock.mockResolvedValue(orderOf());

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '续费' }));
    await screen.findByTestId('pay-qr');

    confirmPaidMock.mockRejectedValueOnce(
      new ApiError(2004, '渠道尚未确认，已转人工核实', undefined, 400, 'pending_review'),
    );
    fireEvent.click(screen.getByRole('button', { name: '我已付款' }));

    expect(await screen.findByTestId('pay-claim-pending')).toHaveTextContent(
      '已转人工核实，管理员确认后自动开通',
    );
    expect(screen.getByRole('button', { name: '我已付款' })).toBeDisabled();
    // 弹层留在原地（轮询继续，admin 通过后自动到账）
    expect(screen.getByTestId('pay-modal')).toBeInTheDocument();
    // 2004 走弹层三态，不再 toast
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('轮询带回 claimStatus=rejected → 「管理员未确认」提示 + 按钮重亮 + 备注框回填可改，note 随重试透传', async () => {
    createOrderMock.mockResolvedValue(orderOf());
    getOrderMock.mockResolvedValue(
      orderOf({ claimStatus: 'rejected', claimNote: '说转了但没收到' }),
    );

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '续费' }));

    expect(await screen.findByTestId('pay-claim-rejected')).toHaveTextContent(
      '管理员未确认本次支付，请核实后重试',
    );
    const confirmBtn = screen.getByRole('button', { name: '我已付款' });
    expect(confirmBtn).toBeEnabled();
    // 备注框回填 admin 驳回前的 claimNote，可修改
    const noteBox = screen.getByTestId('pay-note') as HTMLTextAreaElement;
    expect(noteBox.value).toBe('说转了但没收到');
    fireEvent.change(noteBox, { target: { value: '已重新转账，附凭证' } });
    confirmPaidMock.mockRejectedValueOnce(
      new ApiError(2004, '渠道尚未确认，已转人工核实', undefined, 400, 'pending_review'),
    );
    fireEvent.click(confirmBtn);
    await waitFor(() =>
      expect(confirmPaidMock).toHaveBeenCalledWith('NO123', '已重新转账，附凭证'),
    );
  });

  it('微信/支付宝 2003「支付渠道未配置」→ 错误文案原样展示 + 引导改选线下转账', async () => {
    createOrderMock.mockRejectedValue(new ApiError(2003, '支付渠道未配置', undefined, 503));

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '续费' }));

    expect(await screen.findByTestId('subscription-create-error')).toHaveTextContent(
      '支付渠道未配置',
    );
    expect(screen.getByTestId('subscription-manual-hint')).toHaveTextContent('线下转账');
  });

  it('订单历史 pending + claimStatus=pending_review 行加「人工核实中」徽标；无 claim 的 pending 行不加', async () => {
    listOrdersMock.mockResolvedValue({
      items: [
        orderOf({ orderNo: 'NO9', claimStatus: 'pending_review' }),
        orderOf({ orderNo: 'NO8' }),
      ],
      total: 2,
      page: 1,
      pageSize: 10,
    });

    renderPage();
    await screen.findByTestId('subscription-status-card');
    fireEvent.click(screen.getByTestId('order-history-toggle'));

    const row9 = await screen.findByTestId('order-row-NO9');
    expect(within(row9).getByText('人工核实中')).toBeInTheDocument();
    const row8 = await screen.findByTestId('order-row-NO8');
    expect(within(row8).queryByText('人工核实中')).not.toBeInTheDocument();
  });

  it('订单历史 pending + claimStatus=rejected 行加「管理员已驳回」徽标 + claimNote 截断展示', async () => {
    const fullNote = 'x'.repeat(80) + '；驳回：账上没收到钱';
    listOrdersMock.mockResolvedValue({
      items: [orderOf({ orderNo: 'NO10', claimStatus: 'rejected', claimNote: fullNote })],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    renderPage();
    await screen.findByTestId('subscription-status-card');
    fireEvent.click(screen.getByTestId('order-history-toggle'));

    const row = await screen.findByTestId('order-row-NO10');
    expect(within(row).getByTestId('order-claim-rejected-NO10')).toHaveTextContent('管理员已驳回');
    // claimNote 前 60 字 + …；title 属性含全文
    expect(within(row).getByText('x'.repeat(60) + '…')).toBeInTheDocument();
    expect(screen.getByTitle(fullNote)).toBeInTheDocument();
  });

  it('rejected 行仍可取消（既有按钮不回归）', async () => {
    listOrdersMock.mockResolvedValue({
      items: [orderOf({ orderNo: 'NO10', claimStatus: 'rejected', claimNote: '驳回' })],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    renderPage();
    await screen.findByTestId('subscription-status-card');
    fireEvent.click(screen.getByTestId('order-history-toggle'));

    const row = await screen.findByTestId('order-row-NO10');
    expect(within(row).getByRole('button', { name: '取消' })).toBeInTheDocument();
  });
});
