import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LearningSessionShell from './LearningSessionShell';
import { LEARNING_SESSION_STORAGE_KEY, readPersistedSession, writePersistedSession } from './learningLock';
import { openStudentLearningSession, pollStudentDeviceCommands } from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    openStudentLearningSession: vi.fn(),
    pollStudentDeviceCommands: vi.fn(),
    endStudentLearningSession: vi.fn(),
  };
});

const openMock = vi.mocked(openStudentLearningSession);
const pollMock = vi.mocked(pollStudentDeviceCommands);

const LATER = new Date(Date.now() + 60 * 60_000).toISOString();

let lockCalls: boolean[] = [];

function installBridge() {
  lockCalls = [];
  (window as unknown as { k12Desktop?: unknown }).k12Desktop = {
    isDesktop: true,
    setStudentMode: (on: boolean) => lockCalls.push(on),
  };
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/student/course-detail']}>
      <Routes>
        <Route element={<LearningSessionShell />}>
          <Route path="/student/course-detail" element={<div>学习页</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  installBridge();
  localStorage.setItem('userRole', 'student');
  localStorage.setItem('userId', '9');
  openMock.mockReset();
  openMock.mockResolvedValue({
    id: 7,
    startedAt: '2026-09-23T01:00:00.000Z',
    lockMinutes: 60,
    lockExpiresAt: LATER,
    unlockedAt: null,
  });
  pollMock.mockReset();
  pollMock.mockResolvedValue({ commands: [], lock: null });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { k12Desktop?: unknown }).k12Desktop;
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('LearningSessionShell：建立会话', () => {
  it('学生 + 壳 → 调取或建，并推**学生模式**给壳（进 kiosk）', async () => {
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(lockCalls).toEqual([true]);
    expect(readPersistedSession(9)).toMatchObject({ id: 7, lockExpiresAt: LATER });
    expect(screen.getByText('学习页')).toBeInTheDocument();
  });

  it('**非壳（浏览器）→ 完全不建会话、不推**', async () => {
    delete (window as unknown as { k12Desktop?: unknown }).k12Desktop;
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(openMock).not.toHaveBeenCalled();
    expect(lockCalls).toEqual([]);
  });

  it('非学生角色（家长登录）→ 不建会话，且推 false（回普通窗口）', async () => {
    localStorage.setItem('userRole', 'parent');
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(openMock).not.toHaveBeenCalled();
    expect(lockCalls).toEqual([false]);
  });

  it('已有本地会话 → 不重复建（重启不重置时钟）', async () => {
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(openMock).not.toHaveBeenCalled();
    expect(lockCalls).toEqual([true]);
  });

  it('建会话失败 → 不阻断学习，且**仍然进学生模式**（该全屏还是要全屏）', async () => {
    openMock.mockRejectedValue(new Error('boom'));
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(lockCalls).toEqual([true]);
  });

  it('**未设锁（lockExpiresAt=null）→ 仍然是 kiosk 全屏**（回归钉子：kiosk 由角色决定，不由锁定窗口决定）', async () => {
    openMock.mockResolvedValue({
      id: 7,
      startedAt: '2026-09-23T01:00:00.000Z',
      lockMinutes: null,
      lockExpiresAt: null,
      unlockedAt: null,
    });
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(readPersistedSession(9)).toMatchObject({ lockExpiresAt: null });
    // 家长没设时长 ≠ 学生可以随便切应用：仍要进 kiosk（只是允许登出、不显示 pill）
    expect(lockCalls).toEqual([true]);
    expect(screen.queryByTestId('locked-pill')).not.toBeInTheDocument();
  });
});

describe('LearningSessionShell：轮询与解锁', () => {
  it('轮询取到 unlock 命令 → 解锁并落 unlockedAt（学生模式不变，仍 kiosk）', async () => {
    vi.useFakeTimers();
    pollMock.mockResolvedValue({
      commands: [{ id: 3, command: 'unlock' }],
      lock: { sessionId: 7, lockExpiresAt: LATER, unlockedAt: '2026-09-23T01:20:00.000Z' },
    });
    renderShell();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await act(async () => { await Promise.resolve(); });

    expect(pollMock).toHaveBeenCalled();
    // 「解除锁定」只解除**禁止登出**，不退出 kiosk
    expect(lockCalls[lockCalls.length - 1]).toBe(true);
    expect(readPersistedSession(9)?.unlockedAt).not.toBeNull();
  });

  it('**轮询失败不清锁**（拔网线不解锁）', async () => {
    vi.useFakeTimers();
    pollMock.mockRejectedValue(new Error('offline'));
    renderShell();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    await act(async () => { await Promise.resolve(); });

    expect(lockCalls[lockCalls.length - 1]).toBe(true);
    expect(readPersistedSession(9)?.lockExpiresAt).toBe(LATER);
  });

  it('到点自动解除（不必家长操作），但**仍留在 kiosk**', async () => {
    vi.useFakeTimers();
    const soon = new Date(Date.now() + 2_000).toISOString();
    openMock.mockResolvedValue({
      id: 7,
      startedAt: '2026-09-23T01:00:00.000Z',
      lockMinutes: 1,
      lockExpiresAt: soon,
      unlockedAt: null,
    });
    renderShell();
    await act(async () => { await Promise.resolve(); });
    expect(lockCalls[lockCalls.length - 1]).toBe(true);

    await act(async () => { vi.advanceTimersByTime(3_000); });

    // 到期只解除「禁止登出」与 pill；kiosk 由角色决定，不该跟着退出
    expect(lockCalls[lockCalls.length - 1]).toBe(true);
    expect(screen.queryByTestId('locked-pill')).not.toBeInTheDocument();
  });

  it('锁定中渲染剩余时间 pill；解锁后消失', async () => {
    vi.useFakeTimers();
    renderShell();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('locked-pill')).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(61 * 60_000); });
    expect(screen.queryByTestId('locked-pill')).not.toBeInTheDocument();
  });

  it('未锁定时不渲染 pill', async () => {
    openMock.mockResolvedValue({
      id: 7,
      startedAt: '2026-09-23T01:00:00.000Z',
      lockMinutes: null,
      lockExpiresAt: null,
      unlockedAt: null,
    });
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByTestId('locked-pill')).not.toBeInTheDocument();
  });
});

describe('LearningSessionShell：本地快照', () => {
  it('本地快照损坏也不崩溃，退化为未锁', async () => {
    localStorage.setItem(LEARNING_SESSION_STORAGE_KEY, 'not json');
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText('学习页')).toBeInTheDocument();
    expect(openMock).toHaveBeenCalledTimes(1);
  });
});
