import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import LearningSessionShell from './LearningSessionShell';
import { LEARNING_SESSION_STORAGE_KEY, readPersistedSession, writePersistedSession } from './learningLock';
import { openStudentLearningSession, pollStudentDeviceCommands } from '@/services/api';
import { useLearningLock } from './learningLockContext';
import { useParentUnlocked } from './parentUnlockContext';

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

/** 家长解锁态探针：验证壳有没有把 unlockedByParent 下发对。 */
function UnlockProbe() {
  return <div data-testid="unlock-probe">{String(useParentUnlocked())}</div>;
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/student/course-detail']}>
      <Routes>
        <Route element={<LearningSessionShell />}>
          <Route path="/student/course-detail" element={<><LockProbe /><UnlockProbe /><div>学习页</div></>} />
          <Route path="/student/star-map" element={<div>星图</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** 带「跳转」按钮的壳：用来复现「登录后一串客户端跳转」的场景。 */
function NavProbe() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/student/star-map')}>
      去星图
    </button>
  );
}

/** 把 context 值渲染成文本：pill 已移出本组件，这里断言"状态有没有下发对"。 */
function LockProbe() {
  const lock = useLearningLock();
  return (
    <div data-testid="lock-probe">
      {lock ? `locked:${lock.locked}:${Math.round(lock.remainingMs / 60_000)}` : 'none'}
    </div>
  );
}

function renderShellWithNav() {
  return render(
    <MemoryRouter initialEntries={['/student/course-detail']}>
      <Routes>
        <Route element={<LearningSessionShell />}>
          <Route path="/student/course-detail" element={<NavProbe />} />
          <Route path="/student/star-map" element={<div>星图</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function NavTo({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      {label}
    </button>
  );
}

/** 两条路由都挂解锁探针，用来模拟「学生 9 登出 → 学生 10 登录」而壳不卸载。 */
function renderShellForRelogin() {
  return render(
    <MemoryRouter initialEntries={['/student/course-detail']}>
      <Routes>
        <Route element={<LearningSessionShell />}>
          <Route
            path="/student/course-detail"
            element={<><UnlockProbe /><NavTo to="/student/star-map" label="去星图" /></>}
          />
          <Route
            path="/student/star-map"
            element={<><UnlockProbe /><NavTo to="/student/course-detail" label="回详情" /></>}
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * 模拟「学生 9 登出 → 同一学生 9 重新登录」而壳不卸载。
 * `/login` 代表非学生路由：登出后导航到它，壳会走「非学生」分支并清内存锁。
 */
function renderShellForSameStudentRelogin() {
  return render(
    <MemoryRouter initialEntries={['/student/course-detail']}>
      <Routes>
        <Route element={<LearningSessionShell />}>
          <Route
            path="/student/course-detail"
            element={<><LockProbe /><NavTo to="/login" label="去登录页" /></>}
          />
          <Route
            path="/login"
            element={<><LockProbe /><NavTo to="/student/course-detail" label="回学习页" /></>}
          />
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
    expect(screen.getByTestId('lock-probe')).toHaveTextContent('none');
  });
  it('本地有锁定快照但**不是壳（浏览器）→ 不下发**（"需家长解除"是壳的语义）', async () => {
    delete (window as unknown as { k12Desktop?: unknown }).k12Desktop;
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('lock-probe')).toHaveTextContent('none');
  });
});

describe('LearningSessionShell：轮询与解锁', () => {
  it('轮询取到 unlockedAt → 解锁并落 unlockedAt（学生模式不变，仍 kiosk）', async () => {
    vi.useFakeTimers();
    // 壳不读 commands，真实驱动是 lock.unlockedAt
    pollMock.mockResolvedValue({
      commands: [],
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
    expect(screen.getByTestId('lock-probe')).toHaveTextContent('none');
  });

  it('锁定中下发 locked=true 与剩余分钟；解锁后归零', async () => {
    vi.useFakeTimers();
    renderShell();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('lock-probe')).toHaveTextContent('locked:true:60');

    await act(async () => { vi.advanceTimersByTime(61 * 60_000); });
    expect(screen.getByTestId('lock-probe')).toHaveTextContent('none');
  });

  it('未锁定时不下发锁定态', async () => {
    openMock.mockResolvedValue({
      id: 7,
      startedAt: '2026-09-23T01:00:00.000Z',
      lockMinutes: null,
      lockExpiresAt: null,
      unlockedAt: null,
    });
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('lock-probe')).toHaveTextContent('none');
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

describe('LearningSessionShell：锁的可靠性（2026-09-24 用户实测报回的 bug）', () => {
  it('**登录后立刻跳转也不能丢掉写盘**：本地拿不到带锁会话 → 禁退会失效', async () => {
    // 第一轮「取或建」挂在半空；跳转后重跑的**第二轮**故意永不返回 ——
    // 这样「第二轮兜底写盘」这条后路被堵死，只有「第一轮即使被取消也要落盘」才能让断言通过。
    let resolveFirst!: (v: unknown) => void;
    const first = new Promise((resolve) => {
      resolveFirst = resolve as (v: unknown) => void;
    });
    openMock
      .mockReturnValueOnce(first as never)
      .mockReturnValue(new Promise(() => {}) as never);

    renderShellWithNav();
    await act(async () => { await Promise.resolve(); });

    // 请求还没回来就跳转 → 第一轮 effect 被清理（cancelled=true）
    fireEvent.click(screen.getByRole('button', { name: '去星图' }));
    await act(async () => { await Promise.resolve(); });

    // 现在才回第一轮包
    await act(async () => {
      resolveFirst({
        id: 20,
        startedAt: '2026-09-23T01:00:00.000Z',
        lockMinutes: 10,
        lockExpiresAt: LATER,
        unlockedAt: null,
      });
      await Promise.resolve();
    });

    // 关键：即使这一轮被取消，服务端真值也必须落到本地（否则 LogoutButton 读不到锁）
    expect(readPersistedSession(9)).toMatchObject({ id: 20, lockExpiresAt: LATER });
  });

  it('**轮询发现服务端在别的会话上 → 采纳服务端**（不能丢弃，否则本地卡在旧 id 永远追不上锁）', async () => {
    vi.useFakeTimers();
    // 本地已有一个旧会话（无锁）
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: null, unlockedAt: null });
    // 服务端说：现在进行中的是 id 20，带 10 分钟锁
    pollMock.mockResolvedValue({
      commands: [],
      lock: { sessionId: 20, lockExpiresAt: LATER, unlockedAt: null },
    });

    renderShell();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await act(async () => { await Promise.resolve(); });

    expect(readPersistedSession(9)).toMatchObject({ id: 20, lockExpiresAt: LATER });
  });
});

describe('LearningSessionShell：家长解锁态下发', () => {
  it('轮询拿到 unlockedAt → 下发 true', async () => {
    vi.useFakeTimers();
    // 壳不读 commands，真实驱动是 lock.unlockedAt
    pollMock.mockResolvedValue({
      commands: [],
      lock: { sessionId: 7, lockExpiresAt: LATER, unlockedAt: '2026-09-23T01:20:00.000Z' },
    });
    renderShell();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('unlock-probe')).toHaveTextContent('true');
  });

  it('未解锁 → 下发 false', async () => {
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('unlock-probe')).toHaveTextContent('false');
  });

  it('**锁自然到期 → 仍是 false**（到期不等于家长解除）', async () => {
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
    // 到期前确实锁着（否则「到期后 none」是假绿）
    expect(screen.getByTestId('lock-probe').textContent).toMatch(/^locked:true:/);
    await act(async () => { vi.advanceTimersByTime(3_000); });

    expect(screen.getByTestId('lock-probe')).toHaveTextContent('none');
    expect(screen.getByTestId('unlock-probe')).toHaveTextContent('false');
  });

  it('**非壳（浏览器）→ false**，即使本地快照带 unlockedAt', async () => {
    delete (window as unknown as { k12Desktop?: unknown }).k12Desktop;
    writePersistedSession({
      studentId: 9,
      id: 7,
      lockExpiresAt: LATER,
      unlockedAt: '2026-09-23T01:20:00.000Z',
    });
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('unlock-probe')).toHaveTextContent('false');
  });

  it('**换学生登录：上一位学生的解锁态不残留**（陈旧解锁会 fail-open）', async () => {
    vi.useFakeTimers();
    pollMock.mockResolvedValue({
      commands: [],
      lock: { sessionId: 7, lockExpiresAt: LATER, unlockedAt: '2026-09-23T01:20:00.000Z' },
    });
    renderShellForRelogin();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('unlock-probe')).toHaveTextContent('true');

    // 学生 9 登出：客户端只改 localStorage + 路由，壳不卸载、内存里的 unlockedAt 本来会留着
    localStorage.removeItem('userRole');
    localStorage.removeItem('userId');
    fireEvent.click(screen.getByRole('button', { name: '去星图' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('unlock-probe')).toHaveTextContent('false');

    // 学生 10 登录，且建会话请求永不返回：新会话真值回来之前也不能沿用旧解锁
    localStorage.setItem('userRole', 'student');
    localStorage.setItem('userId', '10');
    openMock.mockReturnValue(new Promise(() => {}) as never);
    fireEvent.click(screen.getByRole('button', { name: '回详情' }));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('unlock-probe')).toHaveTextContent('false');
  });

  it('**重新登录同一学生 → 按本地快照回填内存锁**（否则轮询/心跳不启动、pill 不显示）', async () => {
    vi.useFakeTimers();
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    pollMock.mockResolvedValue({
      commands: [],
      lock: { sessionId: 7, lockExpiresAt: LATER, unlockedAt: null },
    });
    // 快照还在 → 不会重新建会话；这里仍设为永不返回，防止意外走建会话分支掩盖问题
    openMock.mockReturnValue(new Promise(() => {}) as never);

    renderShellForSameStudentRelogin();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('lock-probe').textContent).toMatch(/^locked:true:/);

    // 学生 9 登出：客户端只改 localStorage + 路由，壳不卸载 → 内存锁被清
    localStorage.removeItem('userRole');
    localStorage.removeItem('userId');
    fireEvent.click(screen.getByRole('button', { name: '去登录页' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('lock-probe')).toHaveTextContent('none');

    // 同一学生重新登录（本地快照仍在）→ 进入「有快照」的提前 return 分支
    localStorage.setItem('userRole', 'student');
    localStorage.setItem('userId', '9');
    fireEvent.click(screen.getByRole('button', { name: '回学习页' }));
    await act(async () => { await Promise.resolve(); });

    // ① 锁已按快照回填：pill 有数据（回归钉子：这里曾是 none）
    expect(screen.getByTestId('lock-probe').textContent).toMatch(/^locked:true:/);

    // ② 轮询（兼心跳）恢复：10 秒后再调一次
    const before = pollMock.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(pollMock.mock.calls.length).toBeGreaterThan(before);
  });
});
