import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPersistedSession, writePersistedSession } from './learningLock';
import { endStudentLearningSession } from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, endStudentLearningSession: vi.fn() };
});

const endMock = vi.mocked(endStudentLearningSession);

/** 每个用例装一个新的壳桥，并记下调用。 */
function installBridge() {
  const calls: boolean[] = [];
  (window as unknown as { k12Desktop?: unknown }).k12Desktop = {
    isDesktop: true,
    setStudentMode: (on: boolean) => calls.push(on),
  };
  return calls;
}

beforeEach(() => {
  localStorage.clear();
  endMock.mockReset();
  endMock.mockResolvedValue({ id: 7, endedAt: '2026-09-23T02:00:00.000Z' });
});

afterEach(() => {
  delete (window as unknown as { k12Desktop?: unknown }).k12Desktop;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('isDesktopShell / setDesktopStudentMode', () => {
  it('没有桥（浏览器）→ isDesktopShell() 为 false', async () => {
    const { isDesktopShell } = await import('./desktopBridge');
    expect(isDesktopShell()).toBe(false);
  });

  it('setDesktopStudentMode 把布尔值原样送到桥', async () => {
    const calls = installBridge();
    const { setDesktopStudentMode } = await import('./desktopBridge');
    setDesktopStudentMode(true);
    setDesktopStudentMode(false);
    expect(calls).toEqual([true, false]);
  });

  it('没有桥时 setDesktopStudentMode **不抛错**（浏览器里也是正常路径）', async () => {
    const { setDesktopStudentMode } = await import('./desktopBridge');
    expect(() => setDesktopStudentMode(true)).not.toThrow();
  });
});

describe('releaseOnLogout', () => {
  it('结束服务端会话 + 清本地快照 + 解除壳锁定', async () => {
    const calls = installBridge();
    localStorage.setItem('userId', '9');
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: null, unlockedAt: null });
    const { releaseOnLogout } = await import('./desktopBridge');

    releaseOnLogout();

    expect(endMock).toHaveBeenCalledWith(7);
    expect(readPersistedSession(9)).toBeNull();
    expect(calls).toEqual([false]);
  });

  it('没有本地快照时不发请求，但仍要解除壳锁定', async () => {
    const calls = installBridge();
    localStorage.setItem('userId', '9');
    const { releaseOnLogout } = await import('./desktopBridge');

    releaseOnLogout();

    expect(endMock).not.toHaveBeenCalled();
    expect(calls).toEqual([false]);
  });

  it('结束会话的请求失败**不抛错、也不阻断登出**', async () => {
    installBridge();
    localStorage.setItem('userId', '9');
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: null, unlockedAt: null });
    endMock.mockRejectedValue(new Error('network down'));
    const { releaseOnLogout } = await import('./desktopBridge');

    expect(() => releaseOnLogout()).not.toThrow();
    expect(readPersistedSession(9)).toBeNull();
  });
});
