import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import EntrySelectPage from './EntrySelectPage';
import { getMyPoints, type MyPoints } from '@/services/api';

/**
 * 入口选择页顶栏回归：用户信息入口已从「退出药丸」换成 `UserBadge`（段位入口），
 * 退出由旁边独立的 `LogoutButton` 图标按钮承担（计划 §2.5 / §3 Task 4）。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getMyPoints: vi.fn() };
});

const getMyPointsMock = vi.mocked(getMyPoints);

const POINTS: MyPoints = {
  balance: 120,
  totalEarned: 520,
  todayEarned: 10,
  level: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
  nextLevel: { code: 'qingtong', name: '青铜', index: 2, threshold: 1500 },
  pointsToNextLevel: 980,
  progressPercent: 13,
};

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  stubMatchMedia();
  getMyPointsMock.mockReset();
  getMyPointsMock.mockResolvedValue(POINTS);
  localStorage.setItem('username', '小明');
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/student/entry']}>
      <Routes>
        <Route path="/student/entry" element={<EntrySelectPage />} />
        <Route path="/student/solve" element={<div>solve-page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EntrySelectPage 做题入口', () => {
  it('第 4 卡「做题」跳 /student/solve', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: '进入做题' }));
    expect(screen.getByText('solve-page')).toBeInTheDocument();
  });
});

describe('EntrySelectPage 四宫格布局', () => {
  it('栅格为 1 列 / ≥sm 2 列（2 上 2 下），不再用 lg 4 列', () => {
    renderPage();

    const gridClass = screen.getByTestId('entry-grid').className;
    expect(gridClass).toContain('sm:grid-cols-2');
    expect(gridClass).not.toContain('lg:grid-cols-4');
  });

  it('四张卡统一 3:2 宽高比，无固定 h-64', () => {
    renderPage();

    const labels = ['进入学习', '进入答疑', '进入训练', '进入做题'];
    for (const label of labels) {
      const cardClass = screen.getByRole('button', { name: label }).className;
      expect(cardClass).toContain('aspect-[3/2]');
      expect(cardClass).not.toContain('h-64');
    }
  });
});

describe('EntrySelectPage 用户信息入口', () => {
  it('顶栏渲染 UserBadge（段位入口）且退出按钮独立存在', async () => {
    render(
      <MemoryRouter initialEntries={['/student/entry']}>
        <Routes>
          <Route path="/student/entry" element={<EntrySelectPage />} />
          <Route path="/login" element={<div>登录页</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('user-badge')).toBeInTheDocument();
    expect(screen.getByText('小明')).toBeInTheDocument();
    expect(await screen.findByTestId('user-badge-level-icon')).toBeInTheDocument();
    // 退出仍是独立按钮（不再挂在用户名药丸上）
    expect(screen.getByLabelText('退出登录')).toBeInTheDocument();
  });
});
