import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { PageHeader } from './PageHeader';

/**
 * `PageHeader` 右侧操作区回归：不传 `actions` 时顶栏结构与原来完全一致；
 * 传了才多出右侧插槽（学生端账号药丸 + 退出就挂在这里）。
 */

afterEach(() => cleanup());

function renderAt(element: React.ReactNode) {
  const router = createMemoryRouter(
    [
      { path: '/', element },
      { path: '/student/entry', element: <div>入口选择页</div> },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
}

describe('PageHeader 右侧操作区', () => {
  it('不传 actions 时不渲染右侧插槽（既有页面不变）', () => {
    renderAt(<PageHeader to="/student/entry" caption="返回" title="背单词" />);

    expect(screen.getByRole('heading', { name: '背单词' })).toBeInTheDocument();
    expect(screen.getByText('返回')).toBeInTheDocument();
    expect(screen.queryByTestId('page-header-actions')).not.toBeInTheDocument();
  });

  it('传 actions 时渲染在右侧插槽里', () => {
    renderAt(
      <PageHeader
        to="/student/entry"
        caption="返回"
        title="背单词"
        actions={<button type="button">账号区</button>}
      />,
    );

    const slot = screen.getByTestId('page-header-actions');
    expect(slot).toBeInTheDocument();
    expect(slot).toContainElement(screen.getByRole('button', { name: '账号区' }));
  });
});

describe('PageHeader：onBack 自定义返回', () => {
  it('点击返回只执行 onBack，caption/title 仍是上下两行', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    renderAt(
      <PageHeader
        onBack={onBack}
        backAriaLabel="返回错题本"
        caption="返回错题本"
        title="错题重练"
      />,
    );

    expect(screen.getByText('返回错题本')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '错题重练' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '返回错题本' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
