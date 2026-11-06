import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getMyPoints, type MyPoints } from '@/services/api';
import { StudentAccountActions } from './StudentAccountActions';

/**
 * 学生端右上角账号区：内部复用既有的 `UserBadge` + `LogoutButton`，
 * 页面只需要挂这一个组件。这里钉住两件事——两者都在、退出仍是独立按钮。
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

afterEach(() => cleanup());

beforeEach(() => {
  getMyPointsMock.mockReset();
  getMyPointsMock.mockResolvedValue(POINTS);
  localStorage.setItem('username', '小明');
});

describe('StudentAccountActions', () => {
  it('同时渲染用户状态药丸和独立退出按钮', async () => {
    render(
      <MemoryRouter initialEntries={['/student/training/home']}>
        <Routes>
          <Route
            path="/student/training/home"
            element={<StudentAccountActions />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('user-badge')).toBeInTheDocument();
    expect(await screen.findByTestId('user-badge-level-icon')).toBeInTheDocument();
    expect(screen.getByLabelText('退出登录')).toBeInTheDocument();
  });
});
