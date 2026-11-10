import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import StudentStayLayout from './StudentStayLayout';
import { buildStayReturnState, STAY_FALLBACK_PATH } from '@/utils/stayReturn';
import { LearningLockContext } from '@/kiosk/learningLockContext';

/**
 * 浅停留页（个人中心 / 奖励册 / 练习记录）顶栏「退出本页」的落点回归。
 *
 * 背景：顶栏原先还有左侧「返回」，它与「退出本页」同落点（都走来源页协议）；2026-11-06
 * 用户裁决去掉左侧「返回」，只保留右上角「退出本页」，本文件钉住五件事：
 * 1. 互跳后「退出本页」仍回最初的来源页（承重用例，即 2026-09-21 用户实测的那个 bug）；
 * 2. 来源页自己的 `location.state` 一起还给它（课程详情缺 subjectId/lessonId 会打不开）；
 * 3. 没有来源（直接输地址 / 老书签）→ 兜底回星图；
 * 4. 来源本身是兄弟页 → 不认，仍兜底星图（否则退出会在两页之间打转）；
 * 5. 左侧「返回」已移除，页面上只有「退出本页」一个离开入口。
 *
 * 用 `createMemoryRouter` 挂真外壳 + 真路由断言（不是 mock `useNavigate`）：
 * 「退出本页」的语义就在路由落点上，mock 只能证明调用过 `navigate`。
 */

afterEach(() => cleanup());

function renderStay(
  initialEntry: { pathname: string; state?: unknown },
  lock: { locked: boolean; remainingMs: number } | null = null,
) {
  const router = createMemoryRouter(
    [
      { path: '/student/star-map', element: <div>知识星图</div> },
      { path: '/student/course-detail', element: <div>课程详情</div> },
      { path: '/student/entry', element: <div>入口选择页</div> },
      {
        path: '/student/profile',
        element: <StudentStayLayout />,
        children: [{ index: true, element: <div>个人中心内容</div> }],
      },
      {
        path: '/student/rewards',
        element: <StudentStayLayout />,
        children: [{ index: true, element: <div>奖励册内容</div> }],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  render(
    <LearningLockContext.Provider value={lock}>
      <RouterProvider router={router} />
    </LearningLockContext.Provider>,
  );
  return router;
}

describe('StudentStayLayout 顶栏「退出本页」', () => {
  it('从星图进来、切到奖励册再切回个人中心，退出仍回星图（用户实测的 bug）', async () => {
    const user = userEvent.setup();
    const router = renderStay({
      pathname: '/student/profile',
      state: buildStayReturnState('/student/star-map', undefined),
    });

    await user.click(screen.getByRole('link', { name: '奖励册' }));
    expect(router.state.location.pathname).toBe('/student/rewards');

    await user.click(screen.getByRole('link', { name: '个人中心' }));
    expect(router.state.location.pathname).toBe('/student/profile');

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    expect(router.state.location.pathname).toBe('/student/star-map');
    expect(screen.getByText('知识星图')).toBeInTheDocument();
  });

  it('来源页自己的 location.state 一起带回去（课程详情缺 state 打不开），且不是登出', async () => {
    const user = userEvent.setup();
    localStorage.setItem('token', 'still-logged-in');
    const router = renderStay({
      pathname: '/student/profile',
      state: buildStayReturnState('/student/course-detail', { subjectId: 7, lessonId: 42 }),
    });

    // 个人中心不提供登出：登出只在开始页（EntrySelectPage）右上角
    expect(screen.queryByRole('button', { name: '退出登录' })).not.toBeInTheDocument();

    const exitButton = screen.getByRole('button', { name: '退出本页' });
    // 2026-11-06 用户要求：全仓统一的退出图标
    expect(exitButton.querySelector('[data-icon="exit"]')).toBeInTheDocument();

    await user.click(exitButton);

    expect(router.state.location.pathname).toBe('/student/course-detail');
    expect(router.state.location.state).toEqual({ subjectId: 7, lessonId: 42 });
    expect(localStorage.getItem('token')).toBe('still-logged-in');
    localStorage.removeItem('token');
  });

  it('直接输地址进来（没有来源）→ 兜底回星图，不是回入口选择页', async () => {
    const user = userEvent.setup();
    const router = renderStay({ pathname: '/student/profile' });

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    expect(router.state.location.pathname).toBe(STAY_FALLBACK_PATH);
  });

  it('来源本身是兄弟页（奖励册）→ 不认，兜底回星图', async () => {
    const user = userEvent.setup();
    const router = renderStay({
      pathname: '/student/profile',
      state: buildStayReturnState('/student/rewards', undefined),
    });

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    expect(router.state.location.pathname).toBe(STAY_FALLBACK_PATH);
  });

  it('顶栏不再有左侧「返回」：只有「退出本页」一个离开入口', () => {
    renderStay({ pathname: '/student/profile' });

    expect(screen.queryByRole('button', { name: '返回' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出本页' })).toBeInTheDocument();
  });
});

/**
 * 练习记录（2026-11-06 用户实测后修正）：2026-11-02 曾把它当个人中心的下级页、
 * 按层级「列表→个人中心、详情→列表」；但那是给左侧「返回」定的。左侧按钮删除后，
 * 唯一出口「退出本页」的语义是「从哪进回哪」—— 三个 tab 同权，练习记录也回最初来源。
 */
function renderPracticeHistory(initialPath: string, state?: unknown) {
  const router = createMemoryRouter(
    [
      { path: '/student/star-map', element: <div>知识星图</div> },
      { path: '/student/training/chinese/special', element: <div>语文专项页</div> },
      {
        path: '/student/profile',
        element: <StudentStayLayout />,
        children: [{ index: true, element: <div>个人中心内容</div> }],
      },
      {
        path: '/student/practice-history',
        element: <StudentStayLayout />,
        children: [
          { index: true, element: <div>练习记录列表</div> },
          { path: ':source/:sessionId', element: <div>练习详情内容</div> },
        ],
      },
    ],
    { initialEntries: [{ pathname: initialPath, state }] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('练习记录顶栏「退出本页」也回最初来源', () => {
  it('列表页：从星图进个人中心再切到练习记录，退出回星图（不按层级回个人中心）', async () => {
    const user = userEvent.setup();
    const router = renderPracticeHistory(
      '/student/practice-history',
      buildStayReturnState('/student/star-map', undefined),
    );

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    expect(router.state.location.pathname).toBe('/student/star-map');
    expect(screen.getByText('知识星图')).toBeInTheDocument();
  });

  it('详情页：从语文专项进个人中心、切到练习记录再进详情，退出仍回语文专项', async () => {
    const user = userEvent.setup();
    const router = renderPracticeHistory(
      '/student/practice-history/exam/44',
      buildStayReturnState('/student/training/chinese/special', undefined),
    );

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    expect(router.state.location.pathname).toBe('/student/training/chinese/special');
    expect(screen.getByText('语文专项页')).toBeInTheDocument();
  });

  it('列表页没有来源（直接输地址）→ 兜底回星图', async () => {
    const user = userEvent.setup();
    const router = renderPracticeHistory('/student/practice-history');

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    expect(router.state.location.pathname).toBe(STAY_FALLBACK_PATH);
  });
});

describe('StudentStayLayout 剩余时长浮层', () => {
  it('没有锁定上下文时不渲染识别区', () => {
    renderStay({ pathname: '/student/profile' });
    expect(screen.queryByTestId('pill-reveal-zone')).not.toBeInTheDocument();
  });

  it('锁定时渲染识别区与胶囊，且胶囊不抢点击', () => {
    renderStay({ pathname: '/student/profile' }, { locked: true, remainingMs: 30 * 60_000 });
    expect(screen.getByTestId('pill-reveal-zone')).toBeInTheDocument();
    expect(screen.getByTestId('locked-pill').className).toContain('pointer-events-none');
    // 三个 tab 仍然可点（胶囊在它们下方、且 pointer-events-none）
    expect(screen.getByRole('link', { name: '练习记录' })).toBeInTheDocument();
  });
});

/**
 * 切 tab 重新触发 3 秒自动显示。
 *
 * 三个 tab 是**兄弟路由**，React Router v6 在它们之间导航时会复用同一位置的
 * 同一类型组件（`<RequireRole>` → `<StudentStayLayout />` 不重挂），所以
 * `LockedPillReveal` 的 `visible` 状态会跨 tab 存活、effect 依赖不变 ——
 * 不强制重挂，3 秒只在第一次进入浅停留区时出现一次。
 *
 * 点击用 `fireEvent` 而非 `userEvent`：本文件其余用例（无 fake timers）用 `userEvent`
 * 没问题，但 `userEvent` 的 `asyncWrapper` 在 fake timers 下要等一个 `setTimeout(0)`
 * 才能 resolve（传 `advanceTimers` 或 `delay: null` 都仍然挂住，实测 5s 超时），
 * `LockedPillReveal.test.tsx` 的定时器用例也是用 `fireEvent`。
 */
describe('StudentStayLayout 切 tab 重新触发剩余时长显示', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('进入个人中心显示 3 秒后收起，切到奖励册又重新显示', () => {
    const router = renderStay(
      { pathname: '/student/profile' },
      { locked: true, remainingMs: 30 * 60_000 },
    );

    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'true');

    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'false');

    act(() => { fireEvent.click(screen.getByRole('link', { name: '奖励册' })); });
    // 先确认真的切页了，否则下一条断言证明不了「切 tab 重新显示」
    expect(router.state.location.pathname).toBe('/student/rewards');
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'true');
  });
});
