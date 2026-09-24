import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LogoutButton, toast } from '@/components/base';
import { writePersistedSession } from '@/kiosk/learningLock';
import { endStudentLearningSession } from '@/services/api';

vi.mock('@/components/base/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base/Toast')>();
  return { ...actual, toast: vi.fn() };
});

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, endStudentLearningSession: vi.fn() };
});

const toastMock = vi.mocked(toast);
const endMock = vi.mocked(endStudentLearningSession);
const LATER = new Date(Date.now() + 60 * 60_000).toISOString();

function renderButton() {
  return render(
    <MemoryRouter initialEntries={['/student/course-detail']}>
      <Routes>
        <Route path="/student/course-detail" element={<LogoutButton />} />
        <Route path="/login" element={<div>登录页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function seedSession(studentId: number, opts: { lockExpiresAt: string | null; unlockedAt: string | null }) {
  localStorage.setItem('userId', String(studentId));
  writePersistedSession({ studentId, id: 7, ...opts });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('token', 'jwt');
  localStorage.setItem('username', '小明');
  localStorage.setItem('userRole', 'student');
  localStorage.setItem('userId', '9');
  toastMock.mockReset();
  // 每次重新武装：`afterEach` 的 restoreAllMocks 会抹掉模块 mock 的实现，
  // 而 `vi.mock` 工厂只跑一次（模块被缓存），不重设就会让 `endStudentLearningSession`
  // 返回 undefined → `releaseOnLogout` 里的 `.catch` 抛错 → 登出被自己的收尾逻辑打断。
  endMock.mockReset();
  endMock.mockResolvedValue({ id: 7, endedAt: '2026-09-23T02:00:00.000Z' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('LogoutButton：未锁定', () => {
  it('清掉四个鉴权键并跳到登录页', () => {
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));

    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('userId')).toBeNull();
    expect(localStorage.getItem('username')).toBeNull();
    expect(localStorage.getItem('userRole')).toBeNull();
    expect(screen.getByText('登录页')).toBeInTheDocument();
  });

  it('没有本地会话时也能正常登出（家长/管理员/普通浏览器）', () => {
    localStorage.setItem('userRole', 'parent');
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));
    expect(screen.getByText('登录页')).toBeInTheDocument();
  });
});

describe('LogoutButton：锁定中', () => {
  it('**拒绝登出**：token 仍在、没有跳转', () => {
    seedSession(9, { lockExpiresAt: LATER, unlockedAt: null });
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));

    expect(localStorage.getItem('token')).toBe('jwt');
    expect(screen.queryByText('登录页')).not.toBeInTheDocument();
  });

  it('给出**可解释**的拒绝理由（toast），而不是静默失效', () => {
    seedSession(9, { lockExpiresAt: LATER, unlockedAt: null });
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));

    expect(toastMock).toHaveBeenCalledWith('info', '本次学习时长未满，需家长解除后才能退出');
  });

  it('标记为 aria-disabled，但**保留 aria-label**（4 个现有测试靠它断言存在）', () => {
    seedSession(9, { lockExpiresAt: LATER, unlockedAt: null });
    renderButton();

    const button = screen.getByLabelText('退出登录');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('data-locked', 'true');
    // 原生 disabled 会让 click 不触发 → toast 永远弹不出来，所以必须是 false
    expect(button).not.toBeDisabled();
  });

  it('家长已解除 → 可以正常登出', () => {
    seedSession(9, { lockExpiresAt: LATER, unlockedAt: '2026-09-23T01:20:00.000Z' });
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));
    expect(screen.getByText('登录页')).toBeInTheDocument();
  });

  it('**别的孩子**被锁不影响当前登录者（同设备换人）', () => {
    // 顺序要紧：`seedSession` 会把 `userId` 写成 `studentId`，所以必须先落「学生 9 的会话」，
    // 再把当前登录者改成学生 42。反过来写会被覆盖回 9，这条用例就退化成「本人被锁」。
    seedSession(9, { lockExpiresAt: LATER, unlockedAt: null });
    localStorage.setItem('userId', '42');
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));
    expect(screen.getByText('登录页')).toBeInTheDocument();
  });

  it('到期后自动可登出（不需要家长操作）', () => {
    seedSession(9, { lockExpiresAt: new Date(Date.now() - 1000).toISOString(), unlockedAt: null });
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));
    expect(screen.getByText('登录页')).toBeInTheDocument();
  });

  it('用户名药丸变体同样受管控', () => {
    seedSession(9, { lockExpiresAt: LATER, unlockedAt: null });
    render(
      <MemoryRouter initialEntries={['/student/course-detail']}>
        <Routes>
          <Route path="/student/course-detail" element={<LogoutButton username="小明" />} />
          <Route path="/login" element={<div>登录页</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByLabelText('退出登录'));
    expect(localStorage.getItem('token')).toBe('jwt');
    expect(toastMock).toHaveBeenCalled();
  });
});
