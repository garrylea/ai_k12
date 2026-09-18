import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ProfilePage from './ProfilePage';
import {
  getMyLedger,
  getMyPoints,
  type MyPoints,
  type PointLedgerEntry,
  type PointLedgerPage,
} from '@/services/api';

/**
 * 个人中心（计划 §3 Task 5 / spec §8.1）。
 *
 * 契约要点：
 * 1. 加载中给骨架，不先渲染 0 分（段位没出来就说「劈柴 0 分」会让孩子以为积分归零）；
 * 2. 段位大卡：图标 + `level.name`（段位名单一真源在后端）+ 进度条 + 距下一档；
 * 3. `nextLevel === null`（满级）→ 显示「已达最高段位」且**不含「还差」**；
 * 4. 流水正/负分样式不同；`kind === 'redeem'` 的负流水用**中性色**，绝不用 `--error`；
 * 5. 分页只作用于流水列表，翻页以 `page=2` 调 `me/ledger`；
 * 6. 「兑换记录」没有独立端点（`me/redemptions` 不存在，那在家长端），
 *    用**当前页流水里的 redeem 行**渲染，并明说范围与「以家长端为准」——不编造
 *    「还没有兑换记录」（流水里明明可能有）。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getMyPoints: vi.fn(), getMyLedger: vi.fn() };
});

const getMyPointsMock = vi.mocked(getMyPoints);
const getMyLedgerMock = vi.mocked(getMyLedger);

const POINTS: MyPoints = {
  balance: 120,
  totalEarned: 520,
  todayEarned: 10,
  level: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
  nextLevel: { code: 'qingtong', name: '青铜', index: 2, threshold: 1200 },
  pointsToNextLevel: 680,
  progressPercent: 2,
};

const EARN: PointLedgerEntry = {
  id: 1,
  kind: 'earn',
  title: '数学专项 · 3 题',
  points: 8,
  createdAt: '2026-09-17T10:30:00.000Z',
  refType: 'training_session',
};

const REDEEM: PointLedgerEntry = {
  id: 2,
  kind: 'redeem',
  title: '兑换奖励 · 换个乐高',
  points: -50,
  createdAt: '2026-09-16T09:00:00.000Z',
  refType: null,
};

function ledgerPage(over: Partial<PointLedgerPage> = {}): PointLedgerPage {
  return { items: [EARN, REDEEM], total: 2, page: 1, pageSize: 20, ...over };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/student/profile']}>
      <ProfilePage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  getMyPointsMock.mockReset();
  getMyLedgerMock.mockReset();
});

describe('ProfilePage', () => {
  it('加载中显示骨架，不先渲染 0 分', () => {
    getMyPointsMock.mockReturnValue(new Promise<MyPoints>(() => {}));
    getMyLedgerMock.mockReturnValue(new Promise<PointLedgerPage>(() => {}));

    renderPage();

    expect(screen.getByTestId('profile-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('0 分')).not.toBeInTheDocument();
    expect(screen.queryByText('劈柴')).not.toBeInTheDocument();
    expect(screen.queryByText('可用积分')).not.toBeInTheDocument();
  });

  it('段位大卡用接口的 level.name，并显示进度与「还差 N 分」', async () => {
    getMyPointsMock.mockResolvedValue(POINTS);
    getMyLedgerMock.mockResolvedValue(ledgerPage());

    renderPage();

    expect(await screen.findByText('铸铁')).toBeInTheDocument();
    expect(screen.getByText('还差 680 分')).toBeInTheDocument();
    expect(screen.getByText(/青铜/)).toBeInTheDocument();
    expect(screen.queryByTestId('profile-skeleton')).not.toBeInTheDocument();

    // 段位图标是**真的 svg**（只断言外层 span 等于没断言）
    const icon = screen.getByTestId('profile-level-icon').querySelector('svg');
    expect(icon).not.toBeNull();
  });

  it('积分概览显示可用 / 累计 / 今日', async () => {
    getMyPointsMock.mockResolvedValue(POINTS);
    getMyLedgerMock.mockResolvedValue(ledgerPage());

    renderPage();

    expect(await screen.findByText('120 分')).toBeInTheDocument();
    expect(screen.getByText('520 分')).toBeInTheDocument();
    expect(screen.getByText('10 分')).toBeInTheDocument();
  });

  it('满级（nextLevel === null）显示「已达最高段位」且不含「还差」', async () => {
    getMyPointsMock.mockResolvedValue({
      ...POINTS,
      balance: 21000,
      totalEarned: 21000,
      level: { code: 'wangzhe', name: '王者', index: 8, threshold: 20000 },
      nextLevel: null,
      pointsToNextLevel: null,
      progressPercent: 100,
    });
    getMyLedgerMock.mockResolvedValue(ledgerPage({ items: [EARN], total: 1 }));

    renderPage();

    expect(await screen.findByText('王者')).toBeInTheDocument();
    expect(screen.getByText('已达最高段位')).toBeInTheDocument();
    expect(screen.queryByText(/还差/)).not.toBeInTheDocument();
  });

  it('流水正负分样式不同，且负分行不用 --error', async () => {
    getMyPointsMock.mockResolvedValue(POINTS);
    getMyLedgerMock.mockResolvedValue(ledgerPage());

    renderPage();

    expect(await screen.findByText('+8 分')).toBeInTheDocument();
    // 兑换行在「流水」与「兑换记录」两处都渲染，所以断言要限定在流水列表里
    expect(within(screen.getByTestId('ledger-list')).getByText('-50 分')).toBeInTheDocument();

    const earnClass = screen.getByTestId('ledger-points-1').className;
    const redeemClass = screen.getByTestId('ledger-points-2').className;

    expect(earnClass).not.toBe(redeemClass);
    expect(earnClass).toContain('--success');
    expect(redeemClass).not.toContain('--error');
    expect(redeemClass).toContain('--text-secondary');
  });

  it('无流水时给空态文案', async () => {
    getMyPointsMock.mockResolvedValue(POINTS);
    getMyLedgerMock.mockResolvedValue(ledgerPage({ items: [], total: 0 }));

    renderPage();

    expect(await screen.findByText('暂无积分流水')).toBeInTheDocument();
    expect(screen.getByText('当前页流水里没有兑换记录')).toBeInTheDocument();
  });

  it('流水加载失败 → 给中性提示而不是永远转圈（段位卡仍在）', async () => {
    getMyPointsMock.mockResolvedValue(POINTS);
    getMyLedgerMock.mockRejectedValue(new Error('boom'));

    renderPage();

    expect(await screen.findByText('积分流水暂时加载失败')).toBeInTheDocument();
    expect(screen.getByText('积分流水暂时加载失败，兑换记录也无法显示')).toBeInTheDocument();
    expect(screen.queryByTestId('ledger-skeleton')).not.toBeInTheDocument();
    expect(screen.getByText('铸铁')).toBeInTheDocument();
  });

  it('概览加载失败不连坐流水（两个请求各降级各的）', async () => {
    getMyPointsMock.mockRejectedValue(new Error('boom'));
    getMyLedgerMock.mockResolvedValue(ledgerPage());

    renderPage();

    expect(await screen.findByText('积分信息暂时加载失败')).toBeInTheDocument();
    expect(screen.getByText('+8 分')).toBeInTheDocument();
  });

  it('点下一页以 page=2 调 getMyLedger，并渲染第二页', async () => {
    getMyPointsMock.mockResolvedValue(POINTS);
    getMyLedgerMock.mockResolvedValueOnce(ledgerPage({ total: 25 }));
    getMyLedgerMock.mockResolvedValueOnce(
      ledgerPage({ items: [{ ...EARN, id: 21, title: '第二页第一行' }], total: 25, page: 2 }),
    );

    renderPage();

    expect(await screen.findByText('第 1 / 2 页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    expect(await screen.findByText('第二页第一行')).toBeInTheDocument();
    expect(getMyLedgerMock).toHaveBeenLastCalledWith(2);
    expect(screen.getByText('第 2 / 2 页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled();
  });

  it('兑换记录复用当前页流水的 redeem 行，并说明详细状态以家长端为准', async () => {
    getMyPointsMock.mockResolvedValue(POINTS);
    getMyLedgerMock.mockResolvedValue(ledgerPage());

    renderPage();

    const section = await screen.findByTestId('redemption-records');
    expect(section).toHaveTextContent('兑换奖励 · 换个乐高');
    expect(section).toHaveTextContent('-50 分');
    expect(section).toHaveTextContent(
      '兑换由家长在家长端操作；此处只显示流水，详细状态以家长端为准',
    );
    // 正分流水不是兑换记录，别把整页流水当成兑换记录抄一遍
    expect(section).not.toHaveTextContent('数学专项 · 3 题');
    // 只发一次流水请求：兑换记录不额外打多页
    expect(getMyLedgerMock).toHaveBeenCalledTimes(1);
  });
});
