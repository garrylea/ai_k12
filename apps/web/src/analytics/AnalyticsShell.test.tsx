import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import AnalyticsShell from './AnalyticsShell';
import * as tracker from './tracker';
import { useLearnContextStore } from '@/store/learnContextStore';

function makeTransport() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: <AnalyticsShell />,
        children: [{ path: '/student/training/targeted/run', element: <div>run</div> }],
      },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

let transport: ReturnType<typeof makeTransport>;

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  transport = makeTransport();
  tracker.__resetForTests();
  tracker.setTransport(transport);
});

afterEach(() => {
  cleanup();
  tracker.__resetForTests();
  // 必须在 `unstubAllGlobals()` **之前**：它会还原成 Node 内置的 localStorage
  // （无 `clear`），见 `src/test/setup.ts` 的说明。
  localStorage.clear();
  vi.unstubAllGlobals();
  useLearnContextStore.setState({ subjectId: null, subjectName: null, gradeName: null, publisher: null });
});

describe('AnalyticsShell', () => {
  it('学生角色进入学习页 → 起会话，并把 subjectId 带进 start', async () => {
    localStorage.setItem('userRole', 'student');
    useLearnContextStore.setState({ subjectId: 7, subjectName: '数学', gradeName: null, publisher: null });
    renderAt('/student/training/targeted/run');

    await waitFor(() => expect(transport.start).toHaveBeenCalledTimes(1));
    expect(transport.start.mock.calls[0][0].subjectId).toBe(7);
  });

  it('非学生角色（家长）→ 不启动会话', async () => {
    localStorage.setItem('userRole', 'parent');
    renderAt('/student/training/targeted/run');
    await new Promise((r) => setTimeout(r, 0));
    expect(transport.start).not.toHaveBeenCalled();
  });

  it('pagehide → end(pagehide)', async () => {
    localStorage.setItem('userRole', 'student');
    renderAt('/student/training/targeted/run');
    await waitFor(() => expect(transport.start).toHaveBeenCalled());

    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(transport.end).toHaveBeenCalledWith(expect.any(String), 'pagehide'));
  });

  it('document 隐藏 → hidden 心跳', async () => {
    localStorage.setItem('userRole', 'student');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    renderAt('/student/training/targeted/run');
    await waitFor(() => expect(transport.start).toHaveBeenCalled());

    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() =>
      expect(transport.heartbeat).toHaveBeenCalledWith(expect.any(String), 'hidden'),
    );
  });
});
