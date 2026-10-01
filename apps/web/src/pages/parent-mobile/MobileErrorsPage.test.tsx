import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileErrorsPage from './MobileErrorsPage';
import { useParentStudentStore } from '@/store/parentStudentStore';

afterEach(cleanup);

vi.mock('@/services/api', () => ({ getParentErrors: vi.fn() }));
import { getParentErrors } from '@/services/api';

const item = {
  id: 5, questionId: null, track: 'main' as const, source: 'practice', level: 1,
  isCleared: false, wrongAnswerText: '1/2 + 1/3 = 2/5（存的原题面）', createdAt: '2026-10-01T08:00:00Z',
  clearedAt: null, question: null,
};
const p1 = { items: [item], page: 1, pageSize: 20, total: 1 };

describe('MobileErrorsPage', () => {
  it('渲染错题列表并展示来源与轨道', async () => {
    vi.mocked(getParentErrors).mockResolvedValue(p1 as never);
    useParentStudentStore.setState({ studentId: 1 });
    render(<MobileErrorsPage />);
    expect(await screen.findByText(/1\/2 \+ 1\/3/)).toBeTruthy();
    // 用 /主线 · / 精确匹配列表行：轨道筛选按钮本身也含「主线」二字，getByText(/主线/) 会多命中报错
    expect(screen.getByText(/主线 · /)).toBeTruthy();
    // 首拉只发一次请求（studentId effect 与 page/track effect 不能叠加成两次）
    expect(getParentErrors).toHaveBeenCalledTimes(1);
  });

  it('换孩子回第 1 页并重拉', async () => {
    vi.mocked(getParentErrors).mockResolvedValue(p1 as never);
    useParentStudentStore.setState({ studentId: 1 });
    render(<MobileErrorsPage />);
    await screen.findByText(/1\/2 \+ 1\/3/);
    vi.mocked(getParentErrors).mockClear();
    useParentStudentStore.setState({ studentId: 2 });
    await waitFor(() =>
      expect(getParentErrors).toHaveBeenLastCalledWith(expect.objectContaining({ studentId: 2, page: 1 })),
    );
    // 换孩子只发一次请求（回第 1 页的 setPage 不能再触发一次重拉）
    expect(getParentErrors).toHaveBeenCalledTimes(1);
  });

  it('track 筛选切换触发重拉', async () => {
    vi.mocked(getParentErrors).mockResolvedValue(p1 as never);
    useParentStudentStore.setState({ studentId: 1 });
    render(<MobileErrorsPage />);
    await screen.findByText(/1\/2 \+ 1\/3/);
    await userEvent.click(screen.getByTestId('track-filter-training'));
    await waitFor(() =>
      expect(getParentErrors).toHaveBeenLastCalledWith(expect.objectContaining({ track: 'training' })),
    );
  });

  it('空态与错误重试', async () => {
    vi.mocked(getParentErrors).mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
    useParentStudentStore.setState({ studentId: 1 });
    const { unmount } = render(<MobileErrorsPage />);
    expect(await screen.findByText(/暂无错题/)).toBeTruthy();
    unmount();
    vi.mocked(getParentErrors).mockRejectedValue(new Error('x'));
    render(<MobileErrorsPage />);
    expect(await screen.findByTestId('errors-retry')).toBeTruthy();
  });

  it('展开详情显示完整题面并引导到电脑端看解析（api 无 answer 字段，不新造数据源）', async () => {
    const qItem = {
      ...item,
      id: 7, questionId: 12, wrongAnswerText: null,
      question: { content: '三角形内角和是多少？', type: 'blank', difficulty: 2, knowledgePoints: [] },
    };
    vi.mocked(getParentErrors).mockResolvedValue({ items: [qItem], page: 1, pageSize: 20, total: 1 } as never);
    useParentStudentStore.setState({ studentId: 1 });
    render(<MobileErrorsPage />);
    expect(await screen.findByText(/三角形内角和/)).toBeTruthy();
    await userEvent.click(screen.getByText(/三角形内角和/));
    expect(await screen.findByText(/电脑端/)).toBeTruthy();
  });
});
