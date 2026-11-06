import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
