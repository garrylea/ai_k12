import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { UserBadge } from './UserBadge';
import { getMyPoints, type MyPoints } from '@/services/api';
import { usePointsStore } from '@/store/pointsStore';

/**
 * 用户信息入口 → 段位入口。
 *
 * 契约要点（计划 §2.5 / §3 Task 4）：
 * 1. 药丸 = 头像 + 名字 + 段位图标 + 可用积分；点击**打开段位面板**，不再是退出；
 * 2. 加载完成前显示骨架——**绝不显示「劈柴 0 分」**（孩子会以为积分归零）；
 * 3. 加载失败静默降级：只留头像 + 名字，不报错（用户信息入口不该被积分接口拖垮）；
 * 4. 退出是旁边独立的 `LogoutButton`，点徽章永远不退出。
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

function stubMatchMedia(desktop = false) {
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

function renderBadge(props: Partial<Parameters<typeof UserBadge>[0]> = {}) {
  render(
    <MemoryRouter initialEntries={['/student/entry']}>
      <Routes>
        <Route path="/student/entry" element={<UserBadge username="小明" {...props} />} />
        <Route path="/login" element={<div>登录页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // store 是模块级单例：revision 不归零会串到下个用例，让「只拉一次」断言失败
  usePointsStore.setState({ queue: [], revision: 0 });
});

beforeEach(() => {
  stubMatchMedia();
  getMyPointsMock.mockReset();
  usePointsStore.setState({ queue: [], revision: 0 });
});

describe('UserBadge', () => {
  it('渲染用户名、段位图标与可用积分', async () => {
    getMyPointsMock.mockResolvedValue(BASE);

    renderBadge();

    expect(screen.getByText('小明')).toBeInTheDocument();
    // 断言真正的 svg：外层 testid 的 span 恒在，光断言它等于没断言
    const icon = await screen.findByTestId('user-badge-level-icon');
    expect(icon.querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('user-badge-balance')).toHaveTextContent('120');
    // 数字必须带量词进**可访问名**：aria-label 会覆盖元素内容，
    // 只加 sr-only 的话读屏还是只念 label，永远听不到余额。
    expect(screen.getByTestId('user-badge')).toHaveAccessibleName(
      '小明 · 可用积分 120 · 段位与积分',
    );
  });

  it('加载完成前显示骨架，不显示「0 分」，可访问名也不含余额子句', () => {
    getMyPointsMock.mockReturnValue(new Promise<MyPoints>(() => {}));

    renderBadge();

    expect(screen.getByText('小明')).toBeInTheDocument();
    expect(screen.getByTestId('user-badge-points-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('0 分')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    // 余额未到时不能念出一个不存在的「可用积分」
    expect(screen.getByTestId('user-badge')).toHaveAccessibleName('小明 · 段位与积分');
  });

  it('加载失败 → 静默降级：只留头像 + 名字，无段位/积分、无错误提示', async () => {
    getMyPointsMock.mockRejectedValue(new Error('network down'));

    renderBadge();

    await waitFor(() =>
      expect(screen.queryByTestId('user-badge-points-skeleton')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('小明')).toBeInTheDocument();
    expect(screen.queryByTestId('user-badge-level-icon')).not.toBeInTheDocument();
    expect(screen.queryByTestId('user-badge-balance')).not.toBeInTheDocument();
    expect(screen.queryByText(/失败/)).not.toBeInTheDocument();
  });

  it('点击徽章打开 LevelPanel（再次点击关闭）', async () => {
    // 桌面（≥1024px）：窄屏抽屉有全屏遮罩，真实浏览器里徽章点不到，
    // 「开→再点关」这条路径只在桌面可达。
    stubMatchMedia(true);
    getMyPointsMock.mockResolvedValue(BASE);

    renderBadge();
    await screen.findByTestId('user-badge-level-icon');

    fireEvent.click(screen.getByTestId('user-badge'));

    expect(screen.getByTestId('level-panel')).toBeInTheDocument();
    expect(await screen.findByText('还差 980 分')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('user-badge'));
    expect(screen.queryByTestId('level-panel')).not.toBeInTheDocument();
  });

  it('点击徽章绝不退出登录（退出是旁边独立的图标按钮）', async () => {
    const removeItem = vi.fn();
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem,
      clear: () => {},
    });
    getMyPointsMock.mockRejectedValue(new Error('network down'));

    renderBadge();
    fireEvent.click(screen.getByTestId('user-badge'));

    expect(removeItem).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('退出登录')).not.toBeInTheDocument();
    expect(screen.queryByText('登录页')).not.toBeInTheDocument();
  });

  it('可选 subtitle 渲染为第二行小字（课程详情侧栏「专注学习中...」）', () => {
    getMyPointsMock.mockRejectedValue(new Error('network down'));

    renderBadge({ subtitle: '专注学习中...' });

    expect(screen.getByText('专注学习中...')).toBeInTheDocument();
  });

  it('收到积分发分（revision 递增）后重拉余额并更新徽章', async () => {
    getMyPointsMock
      .mockResolvedValueOnce(BASE)
      .mockResolvedValueOnce({ ...BASE, balance: 130, totalEarned: 530 });

    renderBadge();

    expect(await screen.findByTestId('user-badge-balance')).toHaveTextContent('120');
    // mount 那次只请求一次：订阅 revision 不能把首个值也当成变化
    expect(getMyPointsMock).toHaveBeenCalledTimes(1);

    act(() => {
      usePointsStore.getState().push({ points: 10, title: '本节学习完成' });
    });

    await waitFor(() =>
      expect(screen.getByTestId('user-badge-balance')).toHaveTextContent('130'),
    );
    expect(getMyPointsMock).toHaveBeenCalledTimes(2);
  });

  it('重拉失败时保留旧余额，不把徽章降级成「无积分」', async () => {
    getMyPointsMock
      .mockResolvedValueOnce(BASE)
      .mockRejectedValueOnce(new Error('network down'));

    renderBadge();
    expect(await screen.findByTestId('user-badge-balance')).toHaveTextContent('120');

    act(() => {
      usePointsStore.getState().push({ points: 10, title: '本节学习完成' });
    });

    await waitFor(() => expect(getMyPointsMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('user-badge-balance')).toHaveTextContent('120');
    expect(screen.getByTestId('user-badge-level-icon')).toBeInTheDocument();
  });
});
