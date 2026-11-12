import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { RunExitGuard } from './RunExitGuard';
import { clearSessionRevoked, markSessionRevoked } from '@/services/authStorage';

/** `useBlocker` 必须是 data router（createMemoryRouter），不能用 MemoryRouter。 */
function renderGuard(blockBeforeUnload = true) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <RunExitGuard
            guardRef={{ current: true }}
            blockBeforeUnload={blockBeforeUnload}
            title="离开考试"
            message="离开后计时不会暂停"
          />
        ),
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

function fireBeforeUnload(): Event {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

/**
 * 回归钉子（2026-11-12 用户报「PC App 考试时被别处登录却没被踢」）：
 * 1013 的整页跳转会被本页的 beforeunload 挡住——Electron 对被 beforeunload 取消的
 * unload 是**静默放弃导航**，不弹确认框。所以「已被踢」标记必须让守卫让路。
 */
describe('RunExitGuard：被踢下线时必须让路', () => {
  beforeEach(() => {
    clearSessionRevoked();
  });

  afterEach(() => {
    cleanup();
    clearSessionRevoked();
  });

  it('平时拦截 beforeunload（考试页刷新/关窗要确认）', () => {
    renderGuard();
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
  });

  it('已被踢下线（1013）→ 不拦截，让整页跳登录页真正发生', () => {
    markSessionRevoked();
    renderGuard();
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('没开 blockBeforeUnload 的答题页不受影响', () => {
    renderGuard(false);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });
});
