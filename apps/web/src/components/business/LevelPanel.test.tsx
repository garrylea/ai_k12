import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LevelPanel } from './LevelPanel';
import { computePanelPosition } from './level-panel-position';
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

    // 大段位图标是**真的 svg**（外层 span 恒在，单断言 span 等于没断言）
    const icon = screen.getByTestId('level-panel-level-icon').querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('width', '44');
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

  it('打开后焦点进入面板（兑现 aria-modal），焦点移走后 Esc 仍能关', async () => {
    getMyPointsMock.mockResolvedValue(BASE);

    const onClose = renderPanel();
    await screen.findByText('铸铁');

    expect(screen.getByTestId('level-panel')).toHaveFocus();

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

/**
 * 桌面 popover 的定位数学。
 *
 * jsdom 没有布局引擎，measure 出来恒为 0——所以把 flip/clamp 抽成纯函数在这里
 * 用**构造的 rect** 断言。真机上三个宿主都把徽章放在「视口高、overflow-hidden、
 * 不可滚动」的侧栏底部，只往下弹会整块落到折线以下且滚不到。
 */
describe('computePanelPosition', () => {
  const VIEWPORT = { width: 1024, height: 768 };
  const PANEL = { width: 288, height: 280 };

  it('锚点下方空间充足 → 弹在下方，右缘对齐锚点右缘', () => {
    const pos = computePanelPosition(
      { top: 16, bottom: 48, left: 700, right: 900 },
      PANEL,
      VIEWPORT,
    );

    expect(pos).toEqual({ top: 56, left: 612 });
  });

  it('锚点在视口底部（侧栏页脚）→ 垂直翻转，弹到锚点上方而不是折线以下', () => {
    const anchor = { top: 712, bottom: 752, left: 16, right: 250 };

    const pos = computePanelPosition(anchor, PANEL, VIEWPORT);

    // top = anchor.top - panel.height - gutter
    expect(pos.top).toBe(712 - 280 - 8);
    expect(pos.top + PANEL.height).toBeLessThanOrEqual(anchor.top);
    // 左缘按右缘对齐会到 -38，必须夹回 8，否则 44px 段位图标被裁掉
    expect(pos.left).toBe(8);
  });

  it('锚点贴右缘 → 右缘不越界（夹紧，而不是只护着永不越界的那一侧）', () => {
    const pos = computePanelPosition(
      { top: 400, bottom: 432, left: 900, right: 1020 },
      PANEL,
      VIEWPORT,
    );

    expect(pos.left).toBe(VIEWPORT.width - PANEL.width - 8);
    expect(pos.left + PANEL.width).toBeLessThanOrEqual(VIEWPORT.width - 8);
  });

  it('上下都放不下（面板比可用空间高）→ 仍夹进视口，不返回负数', () => {
    const tall = { width: 288, height: 900 };

    const pos = computePanelPosition(
      { top: 300, bottom: 340, left: 100, right: 300 },
      tall,
      VIEWPORT,
    );

    expect(pos.top).toBe(8);
    expect(pos.left).toBeGreaterThanOrEqual(8);
  });

  it('任意锚点都保证面板四边落在视口留白内', () => {
    for (const anchor of [
      { top: 0, bottom: 30, left: 0, right: 200 },
      { top: 700, bottom: 760, left: 0, right: 120 },
      { top: 300, bottom: 330, left: 950, right: 1024 },
      { top: 380, bottom: 400, left: 400, right: 600 },
    ]) {
      const pos = computePanelPosition(anchor, PANEL, VIEWPORT);
      expect(pos.left).toBeGreaterThanOrEqual(8);
      expect(pos.left + PANEL.width).toBeLessThanOrEqual(VIEWPORT.width - 8);
      expect(pos.top).toBeGreaterThanOrEqual(8);
      expect(pos.top + PANEL.height).toBeLessThanOrEqual(VIEWPORT.height - 8);
    }
  });
});
