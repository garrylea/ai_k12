import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import StudentStayLayout from './StudentStayLayout';
import { buildStayReturnState, STAY_FALLBACK_PATH } from '@/utils/stayReturn';

/**
 * 浅停留页（个人中心 / 奖励册）顶栏「返回」的落点回归。
 *
 * 背景：顶栏原用 `BackButton` 默认模式（`navigate(-1)` 回退浏览器历史）。2026-09-21 用户实测：
 * 从星图点段位面板「查看积分明细 →」进个人中心、点「奖励册」再切回「个人中心」后按「返回」，
 * 退回的是**奖励册**而不是进来的星图 —— 两页互跳把兄弟页压进了历史栈，**历史栈 ≠「从哪来」**。
 * 现改为显式来源页协议（`@/utils/stayReturn`），本文件钉住四件事：
 * 1. 互跳后「返回」仍回最初的来源页（承重用例，即用户实测的那个 bug）；
 * 2. 来源页自己的 `location.state` 一起还给它（课程详情缺 subjectId/lessonId 会打不开）；
 * 3. 没有来源（直接输地址 / 老书签）→ 兜底回星图；
 * 4. 来源本身是兄弟页 → 不认，仍兜底星图（否则「返回」会在两页之间打转）。
 *
 * 用 `createMemoryRouter` 挂真外壳 + 真路由断言（不是 mock `useNavigate`）：
 * 「返回」的语义就在路由落点上，mock 只能证明调用过 `navigate`。
 */

afterEach(() => cleanup());

function renderStay(initialEntry: { pathname: string; state?: unknown }) {
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
  render(<RouterProvider router={router} />);
  return router;
}

describe('StudentStayLayout 顶栏「返回」', () => {
  it('从星图进来、切到奖励册再切回个人中心，返回仍回星图（用户实测的 bug）', async () => {
    const user = userEvent.setup();
    const router = renderStay({
      pathname: '/student/profile',
      state: buildStayReturnState('/student/star-map', undefined),
    });

    await user.click(screen.getByRole('link', { name: '奖励册' }));
    expect(router.state.location.pathname).toBe('/student/rewards');

    await user.click(screen.getByRole('link', { name: '个人中心' }));
    expect(router.state.location.pathname).toBe('/student/profile');

    await user.click(screen.getByRole('button', { name: '返回' }));

    expect(router.state.location.pathname).toBe('/student/star-map');
    expect(screen.getByText('知识星图')).toBeInTheDocument();
  });

  it('来源页自己的 location.state 一起带回去（课程详情缺 state 打不开）', async () => {
    const user = userEvent.setup();
    const router = renderStay({
      pathname: '/student/profile',
      state: buildStayReturnState('/student/course-detail', { subjectId: 7, lessonId: 42 }),
    });

    await user.click(screen.getByRole('button', { name: '返回' }));

    expect(router.state.location.pathname).toBe('/student/course-detail');
    expect(router.state.location.state).toEqual({ subjectId: 7, lessonId: 42 });
  });

  it('直接输地址进来（没有来源）→ 返回兜底回星图', async () => {
    const user = userEvent.setup();
    const router = renderStay({ pathname: '/student/profile' });

    await user.click(screen.getByRole('button', { name: '返回' }));

    expect(router.state.location.pathname).toBe(STAY_FALLBACK_PATH);
  });

  it('来源本身是兄弟页（奖励册）→ 不认，兜底回星图', async () => {
    const user = userEvent.setup();
    const router = renderStay({
      pathname: '/student/profile',
      state: buildStayReturnState('/student/rewards', undefined),
    });

    await user.click(screen.getByRole('button', { name: '返回' }));

    expect(router.state.location.pathname).toBe(STAY_FALLBACK_PATH);
  });
});

describe('StudentStayLayout 顶栏「退出本页」', () => {
  it('回进入本页之前的那一页，并把来源页的 state 一起带回去（不是登出）', async () => {
    const user = userEvent.setup();
    localStorage.setItem('token', 'still-logged-in');
    const router = renderStay({
      pathname: '/student/profile',
      state: buildStayReturnState('/student/course-detail', { subjectId: 7, lessonId: 42 }),
    });

    // 个人中心不提供登出：登出只在开始页（EntrySelectPage）右上角
    expect(screen.queryByRole('button', { name: '退出登录' })).not.toBeInTheDocument();

    const exitButton = screen.getByRole('button', { name: '退出本页' });
    // 2026-11-06 用户要求：小房子换成全仓统一的退出图标
    expect(exitButton.querySelector('[data-icon="exit"]')).toBeInTheDocument();

    await user.click(exitButton);

    expect(router.state.location.pathname).toBe('/student/course-detail');
    expect(router.state.location.state).toEqual({ subjectId: 7, lessonId: 42 });
    expect(localStorage.getItem('token')).toBe('still-logged-in');
    localStorage.removeItem('token');
  });

  it('没有来源时兜底回星图（不是回入口选择页）', async () => {
    const user = userEvent.setup();
    const router = renderStay({ pathname: '/student/profile' });

    await user.click(screen.getByRole('button', { name: '退出本页' }));

    expect(router.state.location.pathname).toBe(STAY_FALLBACK_PATH);
  });
});

/**
 * 练习记录（2026-11-02 用户实测）：原本顶栏「返回」沿用来源页协议，
 * 「星图 → 个人中心 → 练习记录」按返回直接跳回星图（跳过个人中心）。
 * 练习记录是个人中心的下级页，改为**按层级固定返回**：列表→个人中心、详情→列表。
 */
function renderPracticeHistory(initialPath: string, state?: unknown) {
  const router = createMemoryRouter(
    [
      { path: '/student/star-map', element: <div>知识星图</div> },
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

describe('练习记录顶栏「返回」按层级走', () => {
  it('列表页：即使来源是星图，返回也先回个人中心（不跳级）', async () => {
    const user = userEvent.setup();
    const router = renderPracticeHistory(
      '/student/practice-history',
      buildStayReturnState('/student/star-map', undefined),
    );

    await user.click(screen.getByRole('button', { name: '返回' }));

    expect(router.state.location.pathname).toBe('/student/profile');
  });

  it('详情页：返回回到练习记录列表', async () => {
    const user = userEvent.setup();
    const router = renderPracticeHistory('/student/practice-history/exam/44');

    await user.click(screen.getByRole('button', { name: '返回' }));

    expect(router.state.location.pathname).toBe('/student/practice-history');
  });
});
