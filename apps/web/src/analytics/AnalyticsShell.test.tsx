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
        children: [
          { path: '/login', element: <div>login</div> },
          { path: '/student/training/targeted/run', element: <div>run</div> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

/** 三次上报的调用次数快照，用于「卸载后不再有任何上报」的增量断言。 */
function callCounts() {
  return {
    start: transport.start.mock.calls.length,
    heartbeat: transport.heartbeat.mock.calls.length,
    end: transport.end.mock.calls.length,
  };
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
    // 只断言前两个参数：第三个是 subjectId（P6.5 补写用），本用例没有学习上下文 →
    // 它是 null。**别用 `expect.anything()`**——它不匹配 null/undefined。
    await waitFor(() => {
      const last = transport.heartbeat.mock.calls.at(-1);
      expect(last?.[0]).toEqual(expect.any(String));
      expect(last?.[1]).toBe('hidden');
    });
  });

  /**
   * 回归钉子：真实主流程是「落在 /login（还没有 userRole）→ 登录 → 客户端导航进学习页」，
   * 全程**没有页面刷新**，所以路由根元素**不会重新挂载**。角色闸门若只在挂载 effect 里读一次，
   * 这类学生会一直 `enabled=false`，学习时长一条都不上报——而这条路径在「直接挂载到学习页」的
   * 用例里完全看不出来。断言必须落在「路由变化后补上闸门并起会话」上。
   */
  it('从 /login 客户端导航进学习页 → 补上角色闸门并起会话', async () => {
    // 打开 app 落在登录页，此刻 localStorage 里还没有 userRole（走本用例前已 clear）。
    const { router } = renderAt('/login');
    await new Promise((r) => setTimeout(r, 0));
    expect(transport.start).not.toHaveBeenCalled();

    // LoginPage 的真实行为：写 userRole → navigate，是客户端导航，不刷新页面。
    localStorage.setItem('userRole', 'student');
    await router.navigate('/student/training/targeted/run');

    await waitFor(() => expect(transport.start).toHaveBeenCalledTimes(1));
    expect(transport.start.mock.calls[0][0]).toMatchObject({
      module: 'training_targeted',
      scene: 'targeted_run',
    });
  });

  /**
   * 回归钉子：挂载 effect 的六条监听器必须在卸载时全部摘掉。
   * 以「卸载后 transport 不再收到任何上报」为可观测信号——卸载清理本身会收掉在跑的会话
   * （`setEnabled(false)` → `end('closed')`，只此一次），基线取卸载之后。
   */
  it('unmount 后监听器全部摘掉 → 再派发事件不再有任何上报', async () => {
    localStorage.setItem('userRole', 'student');
    const { unmount } = renderAt('/student/training/targeted/run');
    await waitFor(() => expect(transport.start).toHaveBeenCalledTimes(1));

    const beforeUnmount = callCounts();
    unmount();

    // 卸载清理收尾当前会话：恰好一次 end，start / heartbeat 不再新增。
    const afterUnmount = callCounts();
    expect(afterUnmount.end - beforeUnmount.end).toBe(1);
    expect(afterUnmount.start).toBe(beforeUnmount.start);
    expect(afterUnmount.heartbeat).toBe(beforeUnmount.heartbeat);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    window.dispatchEvent(new Event('pagehide'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('keydown'));
    await new Promise((r) => setTimeout(r, 0));

    expect(callCounts()).toEqual(afterUnmount);
  });
});
