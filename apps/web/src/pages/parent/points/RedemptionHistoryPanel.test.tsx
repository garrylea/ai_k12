import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RedemptionHistoryPanel from './RedemptionHistoryPanel';
import { toast } from '@/components/base';
import {
  ApiError,
  getParentRedemptions,
  setRedemptionStatus,
  type RedemptionList,
  type RedemptionView,
} from '@/services/api';

/**
 * 家长端「兑换记录」Tab（计划三 §2.7 / §2.8 / §3 Task 8）。
 *
 * 钉住的契约：
 * 1. 内容列按类型分流：`cash` → `¥X.XX`，`reward` → `rewardName`；
 * 2. 扣除积分是**负数但中性色**——它是消费不是错误，绝不用 `--error`；
 * 3. 「本页待兑现 N 条」筛选 chip（默认显示全部，点一下只看 `pending`；多页时旁注
 *    「翻页可看到更多」——N 只数当前页，文案必须显式限定，不让数字默默低报）；
 * 4. `pending` 行「确认已兑现」→ `PATCH {status:'fulfilled'}` + 重拉当前页；
 * 5. `fulfilled` 行显示 `fulfilledAt` 且可「改回待兑现」→ `{status:'pending'}`；
 * 6. 空态文案 + 跳「兑换」Tab 的链接；
 * 7. `1002`（兑换单不存在）→ toast + 重拉列表；
 * 8. 分页用**服务端回显的 page** 推下一页；`pageSize` 由服务端固定，前端不传。
 */

const CASH_PENDING: RedemptionView = {
  id: 1,
  type: 'cash',
  pointsSpent: 100,
  cashAmount: 5,
  rewardCatalogId: null,
  rewardName: null,
  status: 'pending',
  note: null,
  ledgerId: 9,
  createdAt: '2026-09-18T10:00:00.000Z',
  fulfilledAt: null,
};

const REWARD_FULFILLED: RedemptionView = {
  id: 2,
  type: 'reward',
  pointsSpent: 200,
  cashAmount: null,
  rewardCatalogId: 11,
  rewardName: '周末看电影',
  status: 'fulfilled',
  note: null,
  ledgerId: 10,
  createdAt: '2026-09-17T10:00:00.000Z',
  fulfilledAt: '2026-09-18T09:00:00.000Z',
};

function page(overrides: Partial<RedemptionList> = {}): RedemptionList {
  return {
    items: [CASH_PENDING, REWARD_FULFILLED],
    total: 2,
    page: 1,
    pageSize: 20,
    ...overrides,
  };
}

const EMPTY: RedemptionList = { items: [], total: 0, page: 1, pageSize: 20 };

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getParentRedemptions: vi.fn(),
    setRedemptionStatus: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const getRedemptionsMock = vi.mocked(getParentRedemptions);
const setStatusMock = vi.mocked(setRedemptionStatus);
const toastMock = vi.mocked(toast);

function renderPanel(props: { studentId: number; refreshToken?: number } = { studentId: 1 }) {
  return render(
    <MemoryRouter>
      <RedemptionHistoryPanel {...props} />
    </MemoryRouter>,
  );
}

async function ready() {
  await screen.findByTestId('redemption-row-1');
}

/** 与面板同口径的本地日期时间格式化（避免断言写死 UTC 字符串、受时区影响）。 */
function fmt(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

beforeEach(() => {
  getRedemptionsMock.mockReset();
  setStatusMock.mockReset();
  toastMock.mockReset();
  getRedemptionsMock.mockResolvedValue(page());
  setStatusMock.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RedemptionHistoryPanel：列表渲染', () => {
  it('cash 行显示 ¥X.XX；reward 行显示 rewardName；扣除积分是负分中性色', async () => {
    renderPanel();
    await ready();

    expect(screen.getByTestId('redemption-content-1')).toHaveTextContent('¥5.00');
    expect(screen.getByTestId('redemption-content-2')).toHaveTextContent('周末看电影');

    // 扣分用负数表达，且**不是错误色**。正向断言中性色 token：
    // `not.toContain('--error')` 挡不住 `text-red-500` 或内联红，钉不住「消费≠错误」这个意图。
    const spent = screen.getByTestId('redemption-points-1');
    expect(spent).toHaveTextContent('-100 分');
    expect(spent.className).toContain('text-[var(--text-secondary)]');

    // 类型标签与时间列
    expect(screen.getByTestId('redemption-row-1')).toHaveTextContent('换钱');
    expect(screen.getByTestId('redemption-row-2')).toHaveTextContent('换奖励');
    expect(screen.getByTestId('redemption-row-1')).toHaveTextContent(fmt(CASH_PENDING.createdAt));
  });

  it('fulfilled 行显示 fulfilledAt + 「已兑现」，并提供「改回待兑现」', async () => {
    renderPanel();
    await ready();

    const row = screen.getByTestId('redemption-row-2');
    expect(row).toHaveTextContent('已兑现');
    expect(screen.getByTestId('redemption-fulfilled-2')).toHaveTextContent(
      `已兑现 ${fmt(REWARD_FULFILLED.fulfilledAt as string)}`,
    );
    expect(screen.getByTestId('redemption-revert-2')).toBeInTheDocument();
  });

  /**
   * 脏数据：`fulfilledAt` 为 null（或解析不出日期）时不能渲染成「已兑现 」——
   * 那是个带尾随空格的半个句子。用 `textContent` 精确断言，普通 `toHaveTextContent`
   * 会归一化空白，抓不到尾随空格。
   */
  it('fulfilledAt 为 null → 显示「已兑现 —」，不留半个空句子', async () => {
    getRedemptionsMock.mockResolvedValue(
      page({ items: [{ ...CASH_PENDING, status: 'fulfilled', fulfilledAt: null }] }),
    );

    renderPanel();
    await ready();

    expect(screen.getByTestId('redemption-fulfilled-1').textContent).toBe('已兑现 —');
  });
});

describe('RedemptionHistoryPanel：兑现队列筛选', () => {
  it('「本页待兑现 1 条」chip 计数正确；点一下只看 pending', async () => {
    renderPanel();
    await ready();

    const chip = screen.getByTestId('redemption-pending-chip');
    expect(chip).toHaveTextContent('本页待兑现 1 条');
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    // 默认显示全部
    expect(screen.getByTestId('redemption-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('redemption-row-2')).toBeInTheDocument();

    fireEvent.click(chip);

    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('redemption-row-1')).toBeInTheDocument();
    expect(screen.queryByTestId('redemption-row-2')).not.toBeInTheDocument();
  });

  it('筛选 chip 的计数随数据变化（处理一条后重拉，计数从 1 变 2）', async () => {
    renderPanel();
    await ready();
    expect(screen.getByTestId('redemption-pending-chip')).toHaveTextContent('本页待兑现 1 条');

    // 处理掉唯一 pending 后，服务端回显两个人都是 pending（模拟并发下又有新兑换）
    getRedemptionsMock.mockResolvedValue(
      page({ items: [{ ...CASH_PENDING }, { ...REWARD_FULFILLED, status: 'pending', fulfilledAt: null }] }),
    );
    fireEvent.click(screen.getByTestId('redemption-fulfill-1'));

    await waitFor(() =>
      expect(screen.getByTestId('redemption-pending-chip')).toHaveTextContent('本页待兑现 2 条'),
    );
  });

  /**
   * 计数只数当前页，所以有下一页时必须旁注「翻页可看到更多」——
   * 否则第 1 页清完 pending 就以为队列空了，第 2 页的待兑现被漏掉（队列功能恰恰要防这个）。
   * 单页时本页计数即全部，不该多话。
   */
  it('还有下一页 → chip 旁注「翻页可看到更多」；单页时不显示旁注', async () => {
    getRedemptionsMock.mockResolvedValueOnce(page({ total: 25, page: 1 }));

    renderPanel();
    await ready();

    expect(screen.getByTestId('redemption-pending-hint')).toHaveTextContent('翻页可看到更多');

    // 翻到最后一页（total 25 / pageSize 20 → 第 2 页）后旁注消失
    getRedemptionsMock.mockResolvedValueOnce(page({ total: 25, page: 2 }));
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() =>
      expect(screen.queryByTestId('redemption-pending-hint')).not.toBeInTheDocument(),
    );
  });

  /**
   * 数据未到货时 chip 不渲染：兜底 0 会渲染出「本页待兑现 0 条」并**可点**，
   * 瞬时误导成「队列已空」。这条用永不 resolve 的请求钉住加载态。
   */
  it('加载中（数据未到货）→ chip 不渲染，不出现「待兑现 0 条」', async () => {
    getRedemptionsMock.mockReturnValueOnce(new Promise<RedemptionList>(() => {}));

    renderPanel();

    expect(screen.queryByTestId('redemption-pending-chip')).not.toBeInTheDocument();
  });
});

describe('RedemptionHistoryPanel：兑现状态流转', () => {
  it('「确认已兑现」→ setRedemptionStatus(id, fulfilled) + 重拉当前页', async () => {
    renderPanel();
    await ready();

    fireEvent.click(screen.getByTestId('redemption-fulfill-1'));

    await waitFor(() => expect(setStatusMock).toHaveBeenCalledWith(1, 'fulfilled'));
    await waitFor(() => expect(getRedemptionsMock).toHaveBeenCalledTimes(2));
    // 重拉的是当前页（page 用服务端回显值），且不传 pageSize
    expect(getRedemptionsMock).toHaveBeenLastCalledWith(1, 1);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('success', expect.any(String)));
  });

  it('fulfilled 行「改回待兑现」→ setRedemptionStatus(id, pending)', async () => {
    renderPanel();
    await ready();

    fireEvent.click(screen.getByTestId('redemption-revert-2'));

    await waitFor(() => expect(setStatusMock).toHaveBeenCalledWith(2, 'pending'));
    await waitFor(() => expect(getRedemptionsMock).toHaveBeenCalledTimes(2));
  });

  it('1002（兑换单不存在）→ toast 错误 + 重拉列表', async () => {
    renderPanel();
    await ready();

    setStatusMock.mockRejectedValueOnce(new ApiError(1002, '兑换单不存在'));
    fireEvent.click(screen.getByTestId('redemption-fulfill-1'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '兑换单不存在'));
    await waitFor(() => expect(getRedemptionsMock).toHaveBeenCalledTimes(2));
  });

  it('其它错误 → 通用错误 toast，但不重拉（避免无意义请求）', async () => {
    renderPanel();
    await ready();

    setStatusMock.mockRejectedValueOnce(new ApiError(5000, '服务端开小差了'));
    fireEvent.click(screen.getByTestId('redemption-fulfill-1'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '服务端开小差了'));
    expect(getRedemptionsMock).toHaveBeenCalledTimes(1);
  });
});

describe('RedemptionHistoryPanel：空态与分页', () => {
  it('空态显示「暂无兑换记录」+ 跳「兑换」Tab 的链接', async () => {
    getRedemptionsMock.mockResolvedValue(EMPTY);

    renderPanel();

    expect(await screen.findByText('暂无兑换记录')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /去兑换/ })).toHaveAttribute(
      'href',
      '/parent/rewards?tab=redeem',
    );
  });

  it('点「下一页」以服务端回显的 page+1 调接口（pageSize 不传）', async () => {
    getRedemptionsMock.mockResolvedValueOnce(page({ total: 25, page: 1 }));
    getRedemptionsMock.mockResolvedValueOnce(page({ total: 25, page: 2, items: [CASH_PENDING] }));

    renderPanel();
    await ready();

    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => expect(getRedemptionsMock).toHaveBeenLastCalledWith(1, 2));
    expect(getRedemptionsMock.mock.calls[1]).toHaveLength(2);
    await waitFor(() => expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled());
  });

  it('refreshToken 变化 → 重拉当前页（兑换成功后页面的通知通道）', async () => {
    const { rerender } = render(
      <MemoryRouter>
        <RedemptionHistoryPanel studentId={1} refreshToken={0} />
      </MemoryRouter>,
    );
    await ready();
    expect(getRedemptionsMock).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <RedemptionHistoryPanel studentId={1} refreshToken={1} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getRedemptionsMock).toHaveBeenCalledTimes(2));
    expect(getRedemptionsMock).toHaveBeenLastCalledWith(1, 1);
  });
});
