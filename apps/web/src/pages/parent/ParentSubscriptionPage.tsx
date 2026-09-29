import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { QRCodeSVG } from 'qrcode.react';
import { Button, Card, Modal, Skeleton, toast } from '@/components/base';
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
  type BillingOrderView,
  type PlanView,
  type SubscriptionStatusView,
  type UsageView,
} from '@/services/api';

/**
 * 家长端「订阅管理」（/parent/subscription，批③ Task 3，spec §6.1）。
 *
 * 页面状态机：`loading → ready → paying → success →（3s 自动）→ ready`。
 *
 * - **paying**：支付弹层，`qrContent` 画二维码（qrcode.react）、`redirectUrl` 改「跳转支付宝支付」；
 *   每 3s 轮询 `getBillingOrder`，查到 `paid` 先重拉订阅状态（success 视图要展示新到期时间）
 *   再切 success —— `setView` 触发本 effect 的 cleanup，轮询就此停住（先停后切）。
 *   进入 paying 时立即查一次（订单刚建几乎必是 pending，白等 3s 没有意义），随后挂 interval。
 * - **后端防串单**：已有 pending 单时换套餐/换渠道下单 → 后端 400 / code 2002。
 *   UI 收到 2002 不透传后端文案，改为可操作的指引「已有待支付订单，请先在订单历史中取消」，
 *   并展开 + 刷新订单历史让家长能直接取消。2003/2005 等其余错误以 message 原文展示。
 * - **「我已付款」兜底**：`confirmBillingOrderPaid`；2004（渠道尚未确认）只 toast，
 *   弹层留在原地可再试。
 * - **订单历史**默认收起，展开才拉 `listBillingOrders(1, 10)`；pending 行可就地取消；
 *   若取消的正是弹层里那张单，同时收回弹层。
 * - **AI 用量卡只展示**：`tokensUnknown > 0` 必须注明「量不到 tokens，未计入」——
 *   仓规 NULL≠0，缺口与真实读数不能混（CLAUDE.md）。
 *
 * 配色只走 CSS 变量（`ParentLayout` 已给 `data-theme="parent"`，强制日间）。
 */

type ViewState = 'loading' | 'ready' | 'paying' | 'success';

type Channel = 'wechat' | 'alipay';

const CHANNEL_LABELS: Record<Channel, string> = { wechat: '微信支付', alipay: '支付宝' };

/** `priceCents/100`：19800 → ¥198、1980 → ¥19.8（金额来自服务端，前端不做四舍五入）。 */
function formatYuan(cents: number): string {
  return `¥${cents / 100}`;
}

/** ISO 串取日期部分，避免 toLocaleDateString 在不同运行环境下的格式漂移。 */
function formatDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

function orderStatusBadge(order: BillingOrderView): { label: string; cls: string } {
  switch (order.paymentStatus) {
    case 'pending':
      return { label: '待支付', cls: 'text-[var(--warning)]' };
    case 'paid':
      return { label: '已支付', cls: 'text-[var(--success)]' };
    case 'cancelled':
      return { label: '已取消', cls: 'text-[var(--text-tertiary)]' };
    case 'expired':
      return { label: '已过期', cls: 'text-[var(--text-tertiary)]' };
    default:
      return { label: order.paymentStatus, cls: 'text-[var(--text-tertiary)]' };
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function ParentSubscriptionPage() {
  const [view, setView] = useState<ViewState>('loading');
  const [status, setStatus] = useState<SubscriptionStatusView | null>(null);
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [usage, setUsage] = useState<UsageView | null>(null);
  /** 首屏（订阅状态）加载失败：整页错误卡 + 重试。 */
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);

  const [selectedPlanCode, setSelectedPlanCode] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel>('wechat');

  /** paying 中那张单（弹层展示用）与它的单号（轮询/取消/确认用）。 */
  const [order, setOrder] = useState<BillingOrderView | null>(null);
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState(false);

  /** success 视图展示的新到期时间（paid 后重拉状态时记下）。 */
  const [successPeriodEnd, setSuccessPeriodEnd] = useState<string | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  /** null = 加载中；展开 / 刷新时重拉。 */
  const [history, setHistory] = useState<BillingOrderView[] | null>(null);
  /** 自增触发订单历史重拉（下单 2002、取消订单之后）。 */
  const [historyVersion, setHistoryVersion] = useState(0);

  // --- 首屏加载（订阅状态为主，套餐/用量一并取） ---
  useEffect(() => {
    if (view !== 'loading') return;
    let cancelled = false;
    setLoadFailed(false);
    Promise.all([getSubscriptionStatus(), getSubscriptionPlans(), getAiUsage()])
      .then(([s, p, u]) => {
        if (cancelled) return;
        setStatus(s);
        setPlans(p);
        setUsage(u);
        // 默认选中第一个套餐；重试场景下保留家长已选的档位
        setSelectedPlanCode((prev) => prev ?? p[0]?.planCode ?? null);
        setView('ready');
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [view, reloadVersion]);

  /** 静默重拉订阅状态（取消订单 / 轮询到 paid 之后），失败不打扰。 */
  const refreshStatusQuiet = useCallback(() => {
    getSubscriptionStatus()
      .then(setStatus)
      .catch(() => {
        /* 状态刷新失败不打扰，页面下次进入会重拉 */
      });
  }, []);

  // --- paying：3s 轮询订单状态 ---
  useEffect(() => {
    if (view !== 'paying' || !orderNo) return;
    let cancelled = false;
    const check = async () => {
      try {
        const next = await getBillingOrder(orderNo);
        if (cancelled || next.paymentStatus !== 'paid') return;
        // paid：先重拉状态（success 要展示新到期时间），再切 success。
        // setView 会令本 effect cleanup，interval 被清掉 —— 先停轮询再切视图。
        const s = await getSubscriptionStatus();
        if (cancelled) return;
        setStatus(s);
        setSuccessPeriodEnd(s.currentPeriodEnd);
        setView('success');
      } catch {
        /* 单次轮询失败不打扰，下个周期再查 */
      }
    };
    void check();
    const timer = setInterval(check, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [view, orderNo]);

  // --- success：3s 后自动回 ready（或点关闭） ---
  useEffect(() => {
    if (view !== 'success') return;
    const timer = setTimeout(() => setView('ready'), 3000);
    return () => clearTimeout(timer);
  }, [view]);

  // --- 订单历史：展开 / 刷新时拉第一页 ---
  useEffect(() => {
    if (!historyOpen) return;
    let cancelled = false;
    setHistory(null);
    listBillingOrders(1, 10)
      .then((res) => {
        if (!cancelled) setHistory(res.items);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [historyOpen, historyVersion]);

  const submitOrder = async () => {
    if (!selectedPlanCode || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createBillingOrder(selectedPlanCode, channel);
      setOrder(created);
      setOrderNo(created.orderNo);
      setView('paying');
    } catch (err) {
      if (err instanceof ApiError && err.code === 2002) {
        // 后端防串单：已有 pending 单。不透传后端文案，给可操作的指引并展开订单历史。
        setCreateError('已有待支付订单，请先在订单历史中取消');
        setHistoryOpen(true);
        setHistoryVersion((v) => v + 1);
      } else {
        setCreateError(errorMessage(err, '下单失败，请稍后再试'));
      }
    } finally {
      setCreating(false);
    }
  };

  const confirmPaid = async () => {
    if (!orderNo || confirming) return;
    setConfirming(true);
    try {
      const res = await confirmBillingOrderPaid(orderNo);
      const s = await getSubscriptionStatus();
      setStatus(s);
      setSuccessPeriodEnd(res.currentPeriodEnd ?? s.currentPeriodEnd);
      setView('success');
    } catch (err) {
      if (err instanceof ApiError && err.code === 2004) {
        toast('error', '渠道尚未确认，稍后再试');
      } else {
        toast('error', errorMessage(err, '确认失败，请稍后再试'));
      }
    } finally {
      setConfirming(false);
    }
  };

  /** 弹层里的「取消订单」：取消成功回 ready，并刷新状态与历史。 */
  const cancelPayingOrder = async () => {
    if (!orderNo) return;
    try {
      await cancelBillingOrder(orderNo);
    } catch (err) {
      toast('error', errorMessage(err, '取消失败，请稍后再试'));
      return;
    }
    setOrder(null);
    setOrderNo(null);
    setView('ready');
    setHistoryVersion((v) => v + 1);
    refreshStatusQuiet();
  };

  /** 订单历史行内的「取消」。若取消的正是弹层里那张单，同时收回弹层。 */
  const cancelFromHistory = async (no: string) => {
    try {
      await cancelBillingOrder(no);
    } catch (err) {
      toast('error', errorMessage(err, '取消失败，请稍后再试'));
      return;
    }
    setHistoryVersion((v) => v + 1);
    refreshStatusQuiet();
    if (orderNo === no) {
      setOrder(null);
      setOrderNo(null);
      setView('ready');
    }
  };

  const closeSuccess = useCallback(() => setView('ready'), []);

  if (view === 'loading') {
    if (loadFailed) {
      return (
        <div className="space-y-6">
          <PageHeading />
          <Card data-testid="subscription-error" className="p-10 text-center">
            <p className="text-sm text-[var(--text-secondary)]">订阅信息暂时加载失败</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-4"
              onClick={() => setReloadVersion((v) => v + 1)}
            >
              重试
            </Button>
          </Card>
        </div>
      );
    }
    return (
      <div className="space-y-6" data-testid="subscription-loading">
        <PageHeading />
        <Skeleton width="100%" height={120} rounded />
        <Skeleton width="100%" height={200} rounded />
      </div>
    );
  }

  const statusMeta = (() => {
    if (!status) return null;
    switch (status.status) {
      case 'active':
        return {
          label: `订阅生效中 · 剩余 ${status.daysRemaining} 天`,
          cls: 'text-[var(--success)]',
        };
      case 'trialing':
        return {
          label: `试用中 · 剩余 ${status.daysRemaining} 天`,
          cls: 'text-[var(--success)]',
        };
      case 'expired':
        return { label: '已过期', cls: 'text-[var(--error)]' };
      default:
        return null;
    }
  })();

  const showExpiringSoon =
    status !== null && status.status !== 'expired' && status.daysRemaining <= 7;

  const currentPlanName = status?.planCode
    ? (plans.find((p) => p.planCode === status.planCode)?.name ?? status.planCode)
    : null;

  const isSubscribed = status?.status === 'active' || status?.status === 'trialing';

  return (
    <div className="space-y-6">
      <PageHeading />

      {/* 状态卡 */}
      {status && (
        <Card data-testid="subscription-status-card" data-status={status.status} className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              {statusMeta && (
                <div className={clsx('text-lg font-bold', statusMeta.cls)}>{statusMeta.label}</div>
              )}
              {showExpiringSoon && (
                <span
                  data-testid="subscription-warning-badge"
                  className="mt-2 inline-block rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-xs font-medium text-[var(--warning)]"
                >
                  即将到期
                </span>
              )}
              <div className="mt-2 text-sm text-[var(--text-secondary)]">
                {`到期日期：${formatDate(status.currentPeriodEnd ?? status.trialEndsAt) || '—'}`}
              </div>
            </div>
            {currentPlanName && (
              <div className="shrink-0 text-right">
                <div className="text-xs text-[var(--text-tertiary)]">当前套餐</div>
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                  {currentPlanName}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* 套餐选择 */}
      <Card className="p-6">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">选择套餐</h2>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => {
            const selected = plan.planCode === selectedPlanCode;
            return (
              <button
                key={plan.planCode}
                type="button"
                data-testid={`plan-card-${plan.planCode}`}
                data-selected={selected}
                onClick={() => setSelectedPlanCode(plan.planCode)}
                className={clsx(
                  'rounded-[var(--radius-card)] border p-4 text-left transition-colors',
                  selected
                    ? 'border-[var(--brand-500)] bg-[var(--bg-subtle)]'
                    : 'border-[var(--bg-subtle)] hover:border-[var(--brand-500)]',
                )}
              >
                <div className="font-semibold text-[var(--text-primary)]">{plan.name}</div>
                <div className="mt-1 text-xl font-bold text-[var(--brand-600)]">
                  {formatYuan(plan.priceCents)}
                </div>
                <div className="mt-1 text-xs text-[var(--text-tertiary)]">
                  {`有效期 ${plan.durationDays} 天`}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex items-center gap-6">
          <span className="text-sm text-[var(--text-secondary)]">支付方式</span>
          {(Object.keys(CHANNEL_LABELS) as Channel[]).map((key) => (
            <label key={key} className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
              <input
                type="radio"
                name="channel"
                value={key}
                checked={channel === key}
                onChange={() => setChannel(key)}
              />
              {CHANNEL_LABELS[key]}
            </label>
          ))}
        </div>

        {createError && (
          <p
            data-testid="subscription-create-error"
            className="mt-4 text-sm text-[var(--error)]"
            role="alert"
          >
            {createError}
          </p>
        )}

        <div className="mt-4">
          <Button onClick={submitOrder} disabled={creating || !selectedPlanCode}>
            {creating ? '下单中…' : isSubscribed ? '续费' : '立即订阅'}
          </Button>
        </div>
      </Card>

      {/* AI 用量卡（只展示） */}
      {usage && (
        <Card data-testid="usage-card" className="p-6">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            {`AI 用量（${formatDate(usage.periodStart)} ~ ${formatDate(usage.periodEnd)}）`}
          </h2>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <UsageStat label="调用次数" value={`${usage.calls} 次`} />
            <UsageStat label="输入 tokens" value={String(usage.inputTokens)} />
            <UsageStat label="输出 tokens" value={String(usage.outputTokens)} />
          </div>
          {usage.tokensUnknown > 0 && (
            <p
              data-testid="usage-unknown"
              className="mt-3 text-xs text-[var(--text-tertiary)]"
            >
              {`其中 ${usage.tokensUnknown} 次调用量不到 tokens，未计入`}
            </p>
          )}
        </Card>
      )}

      {/* 订单历史：默认收起 */}
      <Card className="p-6">
        <button
          type="button"
          data-testid="order-history-toggle"
          onClick={() => setHistoryOpen((v) => !v)}
          className="flex w-full items-center justify-between"
          aria-expanded={historyOpen}
        >
          <span className="text-base font-semibold text-[var(--text-primary)]">订单历史</span>
          <span className="text-sm text-[var(--text-secondary)]">
            {historyOpen ? '收起' : '展开'}
          </span>
        </button>

        {historyOpen && (
          <div data-testid="order-history" className="mt-4 space-y-2">
            {history === null ? (
              <Skeleton width="100%" height={48} rounded />
            ) : history.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">暂无订单</p>
            ) : (
              history.map((item) => {
                const badge = orderStatusBadge(item);
                return (
                  <div
                    key={item.orderNo}
                    data-testid={`order-row-${item.orderNo}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-button)] bg-[var(--bg-base)] px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-[var(--text-primary)]">{item.planName}</div>
                      <div className="text-xs text-[var(--text-tertiary)]">
                        {`单号 ${item.orderNo} · ${formatDate(item.createdAt)}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="tabular-nums text-[var(--text-primary)]">
                        {formatYuan(item.amountCents)}
                      </span>
                      <span className={clsx('text-xs font-medium', badge.cls)}>{badge.label}</span>
                      {item.paymentStatus === 'pending' && (
                        <Button variant="secondary" size="sm" onClick={() => cancelFromHistory(item.orderNo)}>
                          取消
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </Card>

      {/* 支付弹层 */}
      <Modal open={view === 'paying'} onClose={() => setView('ready')} title="订单支付">
        {order && (
          <div data-testid="pay-modal">
            <div className="flex items-center justify-between text-sm">
              <span className="text-[var(--text-secondary)]">{order.planName}</span>
              <span className="text-lg font-bold tabular-nums text-[var(--text-primary)]">
                {formatYuan(order.amountCents)}
              </span>
            </div>

            <div className="mt-4 flex flex-col items-center gap-3">
              {order.qrContent ? (
                <div
                  data-testid="pay-qr"
                  className="rounded-[var(--radius-card)] border border-[var(--bg-subtle)] p-3"
                >
                  <QRCodeSVG value={order.qrContent} size={180} />
                  <p className="mt-2 text-center text-xs text-[var(--text-tertiary)]">
                    {`请使用${CHANNEL_LABELS[order.channel as Channel] ?? '支付 App'}扫码支付`}
                  </p>
                </div>
              ) : order.redirectUrl ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (order.redirectUrl) window.open(order.redirectUrl, '_blank', 'noopener,noreferrer');
                  }}
                >
                  跳转支付宝支付
                </Button>
              ) : (
                <p className="text-sm text-[var(--text-secondary)]">
                  支付渠道未返回支付凭证，请稍后重试或更换支付方式
                </p>
              )}
              <p className="text-xs text-[var(--text-tertiary)]">支付完成后页面将自动更新</p>
            </div>

            <div className="mt-5 flex items-center justify-center gap-3">
              <Button onClick={confirmPaid} disabled={confirming}>
                {confirming ? '确认中…' : '我已付款'}
              </Button>
              <Button variant="secondary" onClick={cancelPayingOrder}>
                取消订单
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* 成功弹层：3s 自动回 ready */}
      <Modal open={view === 'success'} onClose={closeSuccess} title="支付成功">
        <div data-testid="subscription-success">
          <p className="text-sm text-[var(--text-secondary)]">订阅已生效。</p>
          {successPeriodEnd && (
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
              {`新的到期日期：${formatDate(successPeriodEnd)}`}
            </p>
          )}
          <div className="mt-5">
            <Button onClick={closeSuccess}>关闭</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function PageHeading() {
  return (
    <header>
      <h1 className="text-2xl font-black tracking-tight text-[var(--text-primary)]">订阅管理</h1>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        查看订阅状态与 AI 用量，选择套餐订阅或续费。
      </p>
    </header>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-button)] bg-[var(--bg-base)] p-4">
      <div className="text-xs text-[var(--text-secondary)]">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-[var(--text-primary)]">{value}</div>
    </div>
  );
}
