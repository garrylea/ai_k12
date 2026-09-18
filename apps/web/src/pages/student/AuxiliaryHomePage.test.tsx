import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AuxiliaryHomePage from './AuxiliaryHomePage';
import { getMyPoints, listAllConversations, type MyPoints } from '@/services/api';

/**
 * 辅学首页侧栏底部回归：用户信息入口换成 `UserBadge`（段位入口），
 * `LogoutButton` 及其 `onLogout`（清空会话状态）**原样保留**（计划 §2.5 / §3 Task 4）。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getMyPoints: vi.fn(),
    listAllConversations: vi.fn().mockResolvedValue([]),
  };
});

const getMyPointsMock = vi.mocked(getMyPoints);
const listAllConversationsMock = vi.mocked(listAllConversations);

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
  listAllConversationsMock.mockResolvedValue([]);
  localStorage.setItem('username', '小明');
});

describe('AuxiliaryHomePage 用户信息入口', () => {
  it('侧栏底部渲染 UserBadge，且退出按钮仍在', async () => {
    render(
      <MemoryRouter initialEntries={['/student/auxiliary']}>
        <Routes>
          <Route path="/student/auxiliary" element={<AuxiliaryHomePage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('user-badge')).toBeInTheDocument();
    expect(screen.getByText('小明')).toBeInTheDocument();
    expect(await screen.findByTestId('user-badge-level-icon')).toBeInTheDocument();
    expect(screen.getByLabelText('退出登录')).toBeInTheDocument();
  });
});
