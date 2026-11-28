import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import StarMapPage from './StarMapPage';
import { fetchStarMap } from '@/services/api';

/**
 * 星图的数据全部按学科取（`?subjectId=`），而这个 id 只由学科选择页写进 `location.state`。
 * 书签、直接输 `/student/star-map`、老地址 `/student` 都没有 state —— 过去这里甩一句
 * 「缺少学生或学科信息，请重新从学科选择页进入」把人卡死（后端重启、没有 session 时尤其
 * 像「登录态失效」）。2026-11-28 改为直接送回学科选择页，且一个接口都不发。
 */
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, fetchStarMap: vi.fn() };
});

const fetchStarMapMock = vi.mocked(fetchStarMap);

beforeEach(() => {
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('userRole', 'student');
  localStorage.setItem('userId', '1');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

describe('StarMapPage 缺少学科维度', () => {
  it('没有 subjectId（书签/直接输地址/老地址进来）→ 送回学科选择页，不发星图请求', async () => {
    const router = createMemoryRouter(
      [
        { path: '/student/subjects', element: <div>学科选择</div> },
        { path: '/student/star-map', element: <StarMapPage /> },
      ],
      { initialEntries: [{ pathname: '/student/star-map' }] },
    );
    render(<RouterProvider router={router} />);

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/subjects'));
    expect(screen.getByText('学科选择')).toBeInTheDocument();
    expect(fetchStarMapMock).not.toHaveBeenCalled();
  });
});
