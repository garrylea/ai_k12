import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LevelPanel } from './LevelPanel';
import { getMyPoints, type MyPoints } from '@/services/api';

/**
 * 段位面板（用户点用户信息入口要看的东西）。
 *
 * 契约要点（计划 §2.5 / §3 Task 4）：
 * 1. 打开时自己调 `GET /api/points/me`；**加载中用骨架，不能先渲染 0 分**
 *    （段位没加载出来就说「劈柴 0 分」会让孩子以为积分归零）；
 * 2. 加载完成显示段位名 + 可用积分 + 「还差 N 分」；
 * 3. `nextLevel === null`（满级）时显示「已达最高段位」且**不显示「还差」**；
 * 4. ≥1024px 桌面 popover、窄屏底部抽屉；Esc 与点外部都要能关。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getMyPoints: vi.fn() };
});

const getMyPointsMock = vi.mocked(getMyPoints);

const BASE: MyPoints = {
  balance: 120,
  totalEarned: 520,
  todayEarned: 10,
  level: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
  nextLevel: { code: 'qingtong', name: '青铜', index: 2, threshold: 1500 },
  pointsToNextLevel: 980,
  progressPercent: 13,
};

/** jsdom 没有 matchMedia；本任务按项目主断点 1024px 判桌面/抽屉，必须自己 stub。 */
function stubMatchMedia(desktop: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width: 1024px') ? desktop : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

function renderPanel(onClose: () => void = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/student/star-map']}>
      <Routes>
        <Route path="/student/star-map" element={<LevelPanel open onClose={onClose} />} />
        <Route path="/student/profile" element={<div>个人中心页</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  stubMatchMedia(true);
  getMyPointsMock.mockReset();
});

describe('LevelPanel', () => {
  it('加载中显示骨架，不显示「0 分」也不显示段位名', () => {
    getMyPointsMock.mockReturnValue(new Promise<MyPoints>(() => {}));

    renderPanel();

    expect(screen.getByTestId('level-panel')).toBeInTheDocument();
    expect(screen.getByTestId('level-panel-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('0 分')).not.toBeInTheDocument();
    expect(screen.queryByText('劈柴')).not.toBeInTheDocument();
    expect(screen.queryByText('可用积分')).not.toBeInTheDocument();
  });

  it('加载完成显示段位名 + 可用积分 + 累计 + 「还差 N 分」', async () => {
    getMyPointsMock.mockResolvedValue(BASE);

    renderPanel();

    expect(await screen.findByText('铸铁')).toBeInTheDocument();
    expect(screen.getByText('120 分')).toBeInTheDocument();
    expect(screen.getByText('累计 520 分')).toBeInTheDocument();
    expect(screen.getByText('还差 980 分')).toBeInTheDocument();
    expect(screen.queryByTestId('level-panel-skeleton')).not.toBeInTheDocument();
  });

  it('nextLevel === null → 显示「已达最高段位」且不显示「还差」', async () => {
    getMyPointsMock.mockResolvedValue({
      ...BASE,
      balance: 9000,
      totalEarned: 9000,
      level: { code: 'wangzhe', name: '王者', index: 8, threshold: 8000 },
      nextLevel: null,
      pointsToNextLevel: null,
      progressPercent: 100,
    });

    renderPanel();

    expect(await screen.findByText('王者')).toBeInTheDocument();
    expect(screen.getByText('已达最高段位')).toBeInTheDocument();
    expect(screen.queryByText(/还差/)).not.toBeInTheDocument();
  });

  it('点「查看积分明细 →」跳 /student/profile', async () => {
    getMyPointsMock.mockResolvedValue(BASE);

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '查看积分明细 →' }));

    expect(await screen.findByText('个人中心页')).toBeInTheDocument();
  });

  it('Esc 关闭', async () => {
    getMyPointsMock.mockResolvedValue(BASE);

    const onClose = renderPanel();
    await screen.findByText('铸铁');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('窄屏为底部抽屉，点遮罩关闭', async () => {
    stubMatchMedia(false);
    getMyPointsMock.mockResolvedValue(BASE);

    const onClose = renderPanel();
    await screen.findByText('铸铁');

    expect(screen.getByTestId('level-panel-backdrop')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('level-panel-backdrop'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('桌面 popover 点外部关闭', async () => {
    getMyPointsMock.mockResolvedValue(BASE);

    const onClose = renderPanel();
    await screen.findByText('铸铁');

    fireEvent.mouseDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
