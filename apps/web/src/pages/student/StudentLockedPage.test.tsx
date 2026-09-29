import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import StudentLockedPage from './StudentLockedPage';
import { getSubscriptionStatus, type SubscriptionStatusView } from '@/services/api';
import { releaseOnLogout } from '@/kiosk/desktopBridge';

/**
 * 学生端订阅锁定页渲染测试（批③ Task 2）。
 *
 * 钉四件事：expired / trialing / 状态拿不到（null 兜底）的文案口径、
 * 「返回登录」按钮存在、点击走统一登出路径（releaseOnLogout + clearAuth 四键清空 +
 * 跳 /login）。登出路径是与 LogoutButton 同一套收尾，不自造第二套。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getSubscriptionStatus: vi.fn(),
  };
});

vi.mock('@/kiosk/desktopBridge', () => ({
  releaseOnLogout: vi.fn(),
}));

const getSubscriptionStatusMock = vi.mocked(getSubscriptionStatus);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/student/locked']}>
      <Routes>
        <Route path="/student/locked" element={<StudentLockedPage />} />
        <Route path="/login" element={<div>登录页钉子</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function statusView(patch: Partial<SubscriptionStatusView>): SubscriptionStatusView {
  return {
    status: 'expired',
    planCode: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    daysRemaining: 0,
    source: 'trial',
    ...patch,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('StudentLockedPage', () => {
  it('status=expired → 显示「订阅已过期」与到期时间', async () => {
    getSubscriptionStatusMock.mockResolvedValue(
      statusView({ status: 'expired', currentPeriodEnd: '2026-09-30T00:00:00.000Z' }),
    );

    renderPage();

    expect(await screen.findByText('订阅已过期')).toBeInTheDocument();
    expect(screen.getByText('到期时间：2026-09-30')).toBeInTheDocument();
  });

  it('status=trialing → 显示「试用已结束」', async () => {
    getSubscriptionStatusMock.mockResolvedValue(statusView({ status: 'trialing' }));

    renderPage();

    expect(await screen.findByText('试用已结束')).toBeInTheDocument();
    expect(screen.queryByText('订阅已过期')).not.toBeInTheDocument();
  });

  it('状态拿不到（接口失败 → data 为 null）→ 兜底显示「本账号未订阅」', async () => {
    getSubscriptionStatusMock.mockRejectedValue(new Error('network down'));

    renderPage();

    expect(await screen.findByText('本账号未订阅')).toBeInTheDocument();
  });

  it('「返回登录」按钮存在', async () => {
    getSubscriptionStatusMock.mockResolvedValue(statusView({}));

    renderPage();

    expect(await screen.findByRole('button', { name: '返回登录' })).toBeInTheDocument();
  });

  it('点击「返回登录」→ 走统一登出路径：releaseOnLogout + 清空四键 + 跳 /login', async () => {
    getSubscriptionStatusMock.mockResolvedValue(statusView({}));
    localStorage.setItem('token', 't');
    localStorage.setItem('userId', '1');
    localStorage.setItem('username', 'xiaoming');
    localStorage.setItem('userRole', 'student');

    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '返回登录' }));

    await waitFor(() => expect(screen.getByText('登录页钉子')).toBeInTheDocument());
    expect(releaseOnLogout).toHaveBeenCalledTimes(1);
    for (const key of ['token', 'userId', 'username', 'userRole']) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });
});
