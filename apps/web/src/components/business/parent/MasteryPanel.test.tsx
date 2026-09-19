import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MasteryPanel from './MasteryPanel';
import { getParentMastery, type ParentMastery } from '@/services/api';
import { useThemeStore } from '@/store/themeStore';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getParentMastery: vi.fn() };
});

const getMasteryMock = vi.mocked(getParentMastery);

const MASTERY: ParentMastery = {
  items: [
    {
      knowledgePointId: 42, name: '分数加减', masteryScore: 0.5, level: 2,
      correctCount: 3, errorCount: 3, lastSeenAt: '2026-09-16T10:00:00.000Z',
    },
  ],
  coveredQuestions: 203,
  totalQuestions: 530,
  uncovered: 327,
};

beforeEach(() => {
  getMasteryMock.mockReset();
  getMasteryMock.mockResolvedValue(MASTERY);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useThemeStore.setState({ mode: 'student-day' });
});

describe('MasteryPanel', () => {
  it('覆盖率三项都展示（不展示家长会以为问题只有列出的几个）', async () => {
    render(<MasteryPanel studentId={11} />);

    const coverage = await screen.findByTestId('mastery-coverage');
    expect(coverage.textContent).toContain('530');
    expect(coverage.textContent).toContain('203');
    expect(coverage.textContent).toContain('327');
    expect(getMasteryMock).toHaveBeenCalledWith(11, 10);
  });

  it('masteryScore 是 0..1 比值 → 显示成百分比（0.5 → 50%，不是 0.5%）', async () => {
    render(<MasteryPanel studentId={11} />);

    const card = await screen.findByTestId('report-mastery');
    expect(card.textContent).toContain('掌握度 50%');
    expect(card.textContent).toContain('分数加减');
    expect(card.textContent).not.toContain('0.5%');
  });

  it('无数据 → 「暂无掌握度数据」，但覆盖率句仍在（否则分不清没数据/没覆盖）', async () => {
    getMasteryMock.mockResolvedValue({ ...MASTERY, items: [] });
    render(<MasteryPanel studentId={11} />);

    const card = await screen.findByTestId('report-mastery');
    await waitFor(() => expect(card.textContent).toContain('暂无掌握度数据'));
    expect(screen.getByTestId('mastery-coverage').textContent).toContain('327');
  });

  it('取数失败 → 卡内错误 + 重试（重试会再取一次）', async () => {
    getMasteryMock.mockRejectedValueOnce(new Error('boom'));
    render(<MasteryPanel studentId={11} />);

    const err = await screen.findByTestId('mastery-error');
    expect(err.textContent).toContain('重试');
    getMasteryMock.mockResolvedValue(MASTERY);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(screen.queryByTestId('mastery-error')).toBeNull());
    expect(await screen.findByTestId('mastery-coverage')).toBeTruthy();
  });

  it('切孩子时请求未回来 → 不残留上一个孩子的数字（防「闪现旧数据」）', async () => {
    const { rerender } = render(<MasteryPanel studentId={11} />);
    await waitFor(() => expect(screen.getByTestId('report-mastery').textContent).toContain('分数加减'));

    getMasteryMock.mockImplementation(() => new Promise<ParentMastery>(() => {}));
    rerender(<MasteryPanel studentId={12} />);

    const card = screen.getByTestId('report-mastery');
    expect(card.textContent).not.toContain('分数加减');
    expect(card.textContent).not.toContain('530');
  });
});
