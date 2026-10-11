import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { VariationOfferCard } from './VariationOfferCard';

/**
 * 错题升级变式提示卡（2026-10-11）。
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 */

afterEach(() => cleanup());

function renderCard(props: Parameters<typeof VariationOfferCard>[0]) {
  const router = createMemoryRouter(
    [
      { path: '/', element: <VariationOfferCard {...props} /> },
      { path: '/student/training/variations/run', element: <div>变式作答页</div> },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

const ITEMS = [
  { variationId: 501, questionId: 88, errorBookId: 33, text: 'x', type: 'choice', options: null, difficulty: 1 },
  { variationId: 502, questionId: 89, errorBookId: 34, text: 'y', type: 'fill_blank', options: null, difficulty: 2 },
];

describe('VariationOfferCard', () => {
  it('variations 为 null（查询中）或空数组（无待练）→ 不渲染', () => {
    renderCard({ variations: null });
    expect(screen.queryByText(/变式练习/)).toBeNull();

    cleanup();
    renderCard({ variations: [] });
    expect(screen.queryByText(/变式练习/)).toBeNull();
  });

  it('有 pending → 渲染提示卡，计数来自列表长度', () => {
    renderCard({ variations: ITEMS });

    expect(screen.getByText('已为本次仍错的错题生成 2 道变式练习')).toBeInTheDocument();
  });

  it('「去练」→ /student/training/variations/run（全量 pending，不带 query）', async () => {
    const user = userEvent.setup();
    const r = createMemoryRouter(
      [
        { path: '/', element: <VariationOfferCard variations={ITEMS} /> },
        { path: '/student/training/variations/run', element: <div>变式作答页</div> },
      ],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={r} />);
    await user.click(screen.getByRole('button', { name: '去练' }));

    expect(r.state.location.pathname).toBe('/student/training/variations/run');
  });

  it('「知道了」→ 卡片消失', async () => {
    const user = userEvent.setup();
    renderCard({ variations: ITEMS });

    await user.click(screen.getByRole('button', { name: '知道了' }));

    expect(screen.queryByText(/变式练习/)).toBeNull();
  });
});
