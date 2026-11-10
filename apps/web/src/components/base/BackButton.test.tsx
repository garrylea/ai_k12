import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { BackButton } from './BackButton';

/**
 * `BackButton` 两种模式的渲染/路由回归。
 *
 * 背景：个人中心 / 奖励册顶栏原先是页内手写的 `<Link to="/student/star-map">返回星图</Link>`，
 * 现改用统一组件并取「返回上一页」语义（`to` 可以不传）。本文件钉住两件事：
 * 1. 传 `to` 的既有 6 处调用**行为完全不变**（真路由跳转，不是 mock 计数）；
 * 2. 不传 `to` 时是真的回退浏览器/内存路由历史一页。
 *
 * 用 `createMemoryRouter` 而不是 mock `useNavigate`：「返回上一页」的语义就在
 * 路由历史栈里，mock 掉 `navigate` 只能证明「调用过 navigate(-1)」，
 * 证明不了点上一步真的回到上一个路由。这里断言 `router.state.location.pathname`。
 */

afterEach(() => cleanup());

describe('BackButton：to 指定路径模式（既有行为，勿回归）', () => {
  it('点击后真的导航到 to 指定路径', async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        { path: '/student/start', element: <BackButton to="/student/entry" /> },
        { path: '/student/entry', element: <div>入口选择页</div> },
      ],
      { initialEntries: ['/student/start'] },
    );
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole('button', { name: '返回' }));

    expect(router.state.location.pathname).toBe('/student/entry');
    expect(screen.getByText('入口选择页')).toBeInTheDocument();
  });

  it('传入 label 时以 label 作为可访问名', () => {
    const router = createMemoryRouter(
      [{ path: '/student/start', element: <BackButton to="/student/star-map" label="返回关卡星图" /> }],
      { initialEntries: ['/student/start'] },
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('button', { name: '返回关卡星图' })).toBeInTheDocument();
  });
});

describe('BackButton：不传 to 的返回上一页模式', () => {
  it('点击后回到上一个路由（承重用例：真路由历史断言）', async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        { path: '/student/star-map', element: <div>知识星图</div> },
        { path: '/student/profile', element: <BackButton /> },
      ],
      { initialEntries: ['/'] },
    );
    // 先造出历史栈：/ → /student/star-map → /student/profile
    await router.navigate('/student/star-map');
    await router.navigate('/student/profile');
    render(<RouterProvider router={router} />);

    expect(router.state.location.pathname).toBe('/student/profile');

    await user.click(screen.getByRole('button', { name: '返回上一页' }));

    // 真路由断言：确实退回了上一个路由，而不是只调了一次 navigate(-1)
    expect(router.state.location.pathname).toBe('/student/star-map');
    expect(screen.getByText('知识星图')).toBeInTheDocument();
  });

  it('不传 to 时默认可访问名为「返回上一页」', () => {
    const router = createMemoryRouter([{ path: '/', element: <BackButton /> }], {
      initialEntries: ['/'],
    });
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('button', { name: '返回上一页' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '返回' })).not.toBeInTheDocument();
  });
});

describe('BackButton：自定义 onClick（重练「先清队列再返回」用）', () => {
  it('只执行 onClick，不再叠加默认导航', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const router = createMemoryRouter(
      [
        { path: '/student/start', element: <BackButton to="/student/entry" onClick={onClick} /> },
        { path: '/student/entry', element: <div>入口选择页</div> },
      ],
      { initialEntries: ['/student/start'] },
    );
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole('button', { name: '返回' }));

    expect(onClick).toHaveBeenCalledTimes(1);
    // 调用方自己负责导航：这里没有 navigate，页面不能自己跳走
    expect(router.state.location.pathname).toBe('/student/start');
  });

  it('ariaLabel 只改可访问名，不渲染可见文字', () => {
    const router = createMemoryRouter(
      [{ path: '/student/start', element: <BackButton to="/student/entry" ariaLabel="返回错题本" /> }],
      { initialEntries: ['/student/start'] },
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('button', { name: '返回错题本' })).toBeInTheDocument();
    expect(screen.queryByText('返回错题本')).toBeNull();
  });
});
