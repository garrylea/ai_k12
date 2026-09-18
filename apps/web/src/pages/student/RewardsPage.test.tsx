import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RewardsPage from './RewardsPage';
import { getMyRewards, type MyRewards, type StudentRewardItem } from '@/services/api';

/**
 * 奖励册（计划 §3 Task 5 / spec §8.1）。
 *
 * 契约要点：
 * 1. 加载中给骨架；
 * 2. 卡三种状态各有明确文案：可兑换 / 分不够（用接口的 `gap`）/ 段位不够（用接口的
 *    `minLevelName`——段位名单一真源在后端，前端不维护段位表）；
 * 3. 两个门槛**可能同时不满足**，文案要同时说清；
 * 4. 学生端**不能自助兑换**，必须明写「找家长兑换」。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getMyRewards: vi.fn() };
});

const getMyRewardsMock = vi.mocked(getMyRewards);

const LEVEL = { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 };

function reward(over: Partial<StudentRewardItem> & { id: number }): StudentRewardItem {
  return {
    name: '奖励',
    description: null,
    pointsCost: 100,
    minLevelCode: null,
    minLevelName: null,
    affordable: true,
    levelOk: true,
    gap: 0,
    ...over,
  };
}

const ITEMS: StudentRewardItem[] = [
  reward({ id: 1, name: '看一集动画', description: '周末可以看一集', pointsCost: 100 }),
  reward({ id: 2, name: '换个乐高', pointsCost: 150, affordable: false, gap: 30 }),
  reward({
    id: 3,
    name: '去看电影',
    pointsCost: 100,
    minLevelCode: 'zuanshi',
    minLevelName: '钻石',
    levelOk: false,
  }),
  reward({
    id: 4,
    name: '去游乐园',
    pointsCost: 200,
    minLevelCode: 'wangzhe',
    minLevelName: '王者',
    affordable: false,
    levelOk: false,
    gap: 80,
  }),
];

const REWARDS: MyRewards = { balance: 120, level: LEVEL, items: ITEMS };

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/student/rewards']}>
      <RewardsPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  getMyRewardsMock.mockReset();
});

describe('RewardsPage', () => {
  it('加载中显示骨架，不先渲染 0 分', () => {
    getMyRewardsMock.mockReturnValue(new Promise<MyRewards>(() => {}));

    renderPage();

    expect(screen.getByTestId('rewards-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('0 分')).not.toBeInTheDocument();
    expect(screen.queryByText('可用积分')).not.toBeInTheDocument();
  });

  it('明写「找家长兑换」与当前可用积分（学生端不能自助兑换）', async () => {
    getMyRewardsMock.mockResolvedValue(REWARDS);

    renderPage();

    expect(await screen.findByText('找家长兑换')).toBeInTheDocument();
    expect(screen.getByText('120 分')).toBeInTheDocument();
    expect(screen.getByText(/铸铁/)).toBeInTheDocument();
  });

  it('无上架奖励时给空态文案', async () => {
    getMyRewardsMock.mockResolvedValue({ ...REWARDS, items: [] });

    renderPage();

    expect(await screen.findByText('家长还没有上架奖励')).toBeInTheDocument();
    expect(screen.queryByTestId('reward-card-1')).not.toBeInTheDocument();
  });

  it('可兑换（affordable && levelOk）→ 高亮「可兑换」，不加置灰', async () => {
    getMyRewardsMock.mockResolvedValue(REWARDS);

    renderPage();

    expect(await screen.findByTestId('reward-card-1')).toBeInTheDocument();

    const card = screen.getByTestId('reward-card-1');
    expect(card).toHaveAttribute('data-state', 'available');
    expect(screen.getByTestId('reward-status-1')).toHaveTextContent('可兑换');
    expect(card.className).not.toContain('opacity-60');
  });

  it('分不够（!affordable）→ 置灰 + 用接口给的 gap 说「还差 N 分」', async () => {
    getMyRewardsMock.mockResolvedValue(REWARDS);

    renderPage();

    const card = await screen.findByTestId('reward-card-2');
    expect(card).toHaveAttribute('data-state', 'locked');
    expect(card.className).toContain('opacity-60');
    expect(screen.getByTestId('reward-status-2')).toHaveTextContent('还差 30 分');
    expect(screen.getByTestId('reward-status-2')).not.toHaveTextContent('可兑换');
    // 「分不够」不是错误，不许用错误色
    expect(screen.getByTestId('reward-status-2').className).not.toContain('--error');
  });

  it('段位不够（affordable && !levelOk）→ 置灰 + 说「需达到」接口给的段位名', async () => {
    getMyRewardsMock.mockResolvedValue(REWARDS);

    renderPage();

    const card = await screen.findByTestId('reward-card-3');
    expect(card).toHaveAttribute('data-state', 'locked');
    expect(card.className).toContain('opacity-60');
    expect(screen.getByTestId('reward-status-3')).toHaveTextContent('段位不够（需达到钻石）');
  });

  it('两个门槛同时不满足 → 两条理由都写出来', async () => {
    getMyRewardsMock.mockResolvedValue(REWARDS);

    renderPage();

    const status = await screen.findByTestId('reward-status-4');
    expect(status).toHaveTextContent('还差 80 分');
    expect(status).toHaveTextContent('段位不够（需达到王者）');
  });

  it('脏 code 致 minLevelName 为 null → 不编段位名，回退成「更高段位」', async () => {
    getMyRewardsMock.mockResolvedValue({
      ...REWARDS,
      items: [
        reward({ id: 9, minLevelCode: 'not-a-level', minLevelName: null, levelOk: false }),
      ],
    });

    renderPage();

    expect(await screen.findByTestId('reward-status-9')).toHaveTextContent(
      '段位不够（需达到更高段位）',
    );
  });
});
