import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Link, RouterProvider } from 'react-router-dom';
import StudentStayLayout from './StudentStayLayout';
import { buildStayReturnState, STAY_FALLBACK_PATH } from '@/utils/stayReturn';
import { LearningLockContext } from '@/kiosk/learningLockContext';
import { probeStudentSession } from '@/services/api';

/** 「退出本页」会先探一次服务端会话（2026-11-28）：默认通过，失效/非会话失败的用例自行覆盖。 */
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, probeStudentSession: vi.fn() };
});

const probeMock = vi.mocked(probeStudentSession);

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

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  probeMock.mockReset();
  probeMock.mockResolvedValue(true);
});

/** 有效 JWT：浅停留页只有登录态能进，「退出本页」会查 isSessionValid，测试须按真实口径给未过期 token。 */
function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

function renderStay(
  initialEntry: { pathname: string; state?: unknown },
  lock: { locked: boolean; remainingMs: number } | null = null,
) {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'student');
  const router = createMemoryRouter(
    [
      { path: '/login', element: <div>登录页</div> },
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
      {
        path: '/student/featured-sets',
        element: <StudentStayLayout />,
        children: [{ index: true, element: <div>精选题单内容</div> }],
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

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/star-map'));
    expect(screen.getByText('知识星图')).toBeInTheDocument();
  });

  it('来源页自己的 location.state 一起带回去（课程详情缺 state 打不开），且不是登出', async () => {
    const user = userEvent.setup();
    const tokenBefore = validToken();
    localStorage.setItem('token', tokenBefore);
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

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/course-detail'));
    expect(router.state.location.state).toEqual({ subjectId: 7, lessonId: 42 });
    // 「退出本页」不是登出：token 原样保留（会话仍有效时）
    expect(localStorage.getItem('token')).toBe(tokenBefore);
  });

  it('直接输地址进来（没有来源）→ 兜底回星图，不是回入口选择页', async () => {
    const user = userEvent.setup();
    const router = renderStay({ pathname: '/student/profile' });

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(STAY_FALLBACK_PATH));
  });

  it('来源本身是兄弟页（奖励册）→ 不认，兜底回星图', async () => {
    const user = userEvent.setup();
    const router = renderStay({
      pathname: '/student/profile',
      state: buildStayReturnState('/student/rewards', undefined),
    });

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(STAY_FALLBACK_PATH));
  });

  /**
   * 2026-11-28：本地 JWT 的 exp 还没到、但服务端会话已失效（后端重启后注册表重建失败/被踢/吊销）。
   * 探针命中 1003/1013 → api 层清登录态并整页跳登录页、返回永不 resolve 的 Promise ——
   * 用同形状的挂起 Promise 模拟：绝不能先回来源页（来源页同样要登录）。
   */
  it('本地 token 未过期但服务端会话失效 → 不回星图，停在原页等跳登录', async () => {
    const user = userEvent.setup();
    probeMock.mockReturnValue(new Promise(() => {}));
    const router = renderStay({
      pathname: '/student/profile',
      state: buildStayReturnState('/student/star-map', undefined),
    });

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    await waitFor(() => expect(probeMock).toHaveBeenCalled());
    expect(router.state.location.pathname).toBe('/student/profile');
  });

  /** 网络抖动 / 5xx 返回 false：不能把人当登录过期踢走，照常回来源页。 */
  it('探针非会话类失败 → 照常回来源页，不阻断退出', async () => {
    const user = userEvent.setup();
    probeMock.mockResolvedValue(false);
    const router = renderStay({
      pathname: '/student/profile',
      state: buildStayReturnState('/student/star-map', undefined),
    });

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/star-map'));
  });

  it('顶栏不再有左侧「返回」：只有「退出本页」一个离开入口', () => {
    renderStay({ pathname: '/student/profile' });

    expect(screen.queryByRole('button', { name: '返回' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出本页' })).toBeInTheDocument();
  });

  it('浅停留页新增「精选题单」顶层 Tab，可独立进入完整列表', async () => {
    const user = userEvent.setup();
    const router = renderStay({ pathname: '/student/profile' });

    const link = screen.getByRole('link', { name: '精选题单' });
    expect(link).toHaveAttribute('href', '/student/featured-sets');

    await user.click(link);
    expect(router.state.location.pathname).toBe('/student/featured-sets');
    expect(screen.getByText('精选题单内容')).toBeInTheDocument();
  });

  it('会话已失效（停留期间 token 过期/被清）→ 退出本页直接回登录页带原因，不落到来源页', async () => {
    const user = userEvent.setup();
    const router = renderStay({
      pathname: '/student/profile',
      state: buildStayReturnState('/student/star-map', undefined),
    });
    // 模拟停留期间会话失效：来源页（星图）同样要登录，退过去会卡死
    localStorage.removeItem('token');

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?reason=expired');
    expect(screen.getByText('登录页')).toBeInTheDocument();
  });
});

/**
 * 练习记录（2026-11-06 用户实测后修正）：2026-11-02 曾把它当个人中心的下级页、
 * 按层级「列表→个人中心、详情→列表」；但那是给左侧「返回」定的。左侧按钮删除后，
 * 唯一出口「退出本页」的语义是「从哪进回哪」—— 四个 tab 同权，练习记录也回最初来源。
 */
function renderPracticeHistory(
  initialPath: string,
  state?: unknown,
  lock: { locked: boolean; remainingMs: number } | null = null,
) {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'student');
  const router = createMemoryRouter(
    [
      { path: '/login', element: <div>登录页</div> },
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
          {
            index: true,
            element: (
              <div>
                练习记录列表
                <Link to="/student/practice-history/exam/44">第 1 条记录</Link>
              </div>
            ),
          },
          { path: ':source/:sessionId', element: <div>练习详情内容</div> },
        ],
      },
    ],
    { initialEntries: [{ pathname: initialPath, state }] },
  );
  render(
    <LearningLockContext.Provider value={lock}>
      <RouterProvider router={router} />
    </LearningLockContext.Provider>,
  );
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

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/star-map'));
    expect(screen.getByText('知识星图')).toBeInTheDocument();
  });

  it('详情页：从语文专项进个人中心、切到练习记录再进详情，退出仍回语文专项', async () => {
    const user = userEvent.setup();
    const router = renderPracticeHistory(
      '/student/practice-history/exam/44',
      buildStayReturnState('/student/training/chinese/special', undefined),
    );

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/chinese/special'));
    expect(screen.getByText('语文专项页')).toBeInTheDocument();
  });

  it('列表页没有来源（直接输地址）→ 兜底回星图', async () => {
    const user = userEvent.setup();
    const router = renderPracticeHistory('/student/practice-history');

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(STAY_FALLBACK_PATH));
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
    // 四个 tab 仍然可点（胶囊在它们下方、且 pointer-events-none）
    expect(screen.getByRole('link', { name: '练习记录' })).toBeInTheDocument();
  });
});

/**
 * 切 tab 重新触发 3 秒自动显示。
 *
 * 四个 tab 是**兄弟路由**，React Router v6 在它们之间导航时会复用同一位置的
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

/**
 * 详情页边界（spec §2.2 第 76 行）：「练习记录详情页进入时不自动弹，避免学生正在看记录时
 * 被闪一下」。列表 → 详情属于**同一 tab 段内**导航，reveal 不得因 pathname 变化而重挂。
 *
 * 用完整 pathname 作 key 时这条会挂：点进详情 key 变化 → reveal 重挂 → 立刻又显示 3 秒。
 * 所以 key 必须是「所属主 tab 段」而不是完整 pathname。
 */
describe('StudentStayLayout 练习记录详情页不自动弹剩余时长', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('列表进入显示 3 秒收起，点进详情后不再自动显示', () => {
    const router = renderPracticeHistory(
      '/student/practice-history',
      undefined,
      { locked: true, remainingMs: 30 * 60_000 },
    );

    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'false');

    act(() => { fireEvent.click(screen.getByRole('link', { name: '第 1 条记录' })); });
    expect(router.state.location.pathname).toBe('/student/practice-history/exam/44');
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'false');
  });
});
