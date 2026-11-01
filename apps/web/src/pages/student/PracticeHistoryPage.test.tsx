import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PracticeHistoryPage from './PracticeHistoryPage';
import { getPracticeHistory } from '@/services/api';

/**
 * 练习记录列表（2026-11-01）。
 * 契约：加载骨架 / 列表项（学科+卷名+日期+对错比+来源）/ 空态 / 进行中灰显 + 「进行中」。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getPracticeHistory: vi.fn() };
});

const getPracticeHistoryMock = vi.mocked(getPracticeHistory);

const EXAM_ITEM = {
  source: 'exam' as const,
  sessionId: 1,
  subjectId: 4,
  title: '北师大物理实验卷',
  module: null,
  startedAt: '2026-11-01T06:00:00.000Z',
  completedAt: '2026-11-01T06:40:00.000Z',
  totalCount: 10,
  correctCount: 7,
};

afterEach(() => cleanup());

describe('PracticeHistoryPage', () => {
  it('加载中显示骨架', () => {
    getPracticeHistoryMock.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><PracticeHistoryPage /></MemoryRouter>);
    expect(screen.getByTestId('history-skeleton')).toBeInTheDocument();
  });

  it('有数据时渲染列表项（学科 + 卷名 + 对错比 + 来源）', async () => {
    getPracticeHistoryMock.mockResolvedValue({ items: [EXAM_ITEM], total: 1, page: 1, pageSize: 20 });
    render(<MemoryRouter><PracticeHistoryPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('北师大物理实验卷')).toBeInTheDocument());
    // 「物理」同时出现在学科筛选按钮与列表项标签上
    expect(screen.getAllByText('物理').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('共 10 题 · 对 7/10')).toBeInTheDocument();
    expect(screen.getByText('考试')).toBeInTheDocument();
  });

  it('同一套卷子做两次显示两条（session 粒度）', async () => {
    getPracticeHistoryMock.mockResolvedValue({
      items: [EXAM_ITEM, { ...EXAM_ITEM, sessionId: 2, startedAt: '2026-10-31T06:00:00.000Z' }],
      total: 2, page: 1, pageSize: 20,
    });
    render(<MemoryRouter><PracticeHistoryPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('北师大物理实验卷')).toHaveLength(2));
  });

  it('空态引导去训练轨', async () => {
    getPracticeHistoryMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<MemoryRouter><PracticeHistoryPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('history-empty')).toBeInTheDocument());
    expect(screen.getByText(/还没有练习记录/)).toBeInTheDocument();
  });

  it('进行中（completedAt=null）显示「进行中」', async () => {
    getPracticeHistoryMock.mockResolvedValue({
      items: [{ ...EXAM_ITEM, completedAt: null }], total: 1, page: 1, pageSize: 20,
    });
    render(<MemoryRouter><PracticeHistoryPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('进行中')).toBeInTheDocument());
  });

  it('切学科回第 1 页并带 subjectId 重取', async () => {
    getPracticeHistoryMock.mockResolvedValue({ items: [EXAM_ITEM], total: 40, page: 2, pageSize: 20 });
    render(<MemoryRouter><PracticeHistoryPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('北师大物理实验卷')).toBeInTheDocument());

    getPracticeHistoryMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '数学' }));
    await waitFor(() =>
      expect(getPracticeHistoryMock).toHaveBeenCalledWith({ page: 1, pageSize: 20, subjectId: 1 }),
    );
  });

  it('加载失败显示错误卡片', async () => {
    getPracticeHistoryMock.mockRejectedValue(new Error('network'));
    render(<MemoryRouter><PracticeHistoryPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/暂时加载失败/)).toBeInTheDocument());
  });
});
