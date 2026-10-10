import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsRetentionPage from './AnalyticsRetentionPage';
import { getAdminRetention, type RetentionData } from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getAdminRetention: vi.fn() };
});

const getRetentionMock = vi.mocked(getAdminRetention);

afterEach(() => cleanup());

const DATA: RetentionData = {
  cohortStart: '2026-09-10',
  cohortSize: 12,
  days: [
    { offset: 1, retained: 6, rate: 0.5 },
    { offset: 7, retained: 3, rate: 0.25 },
    { offset: 30, retained: 1, rate: null },
  ],
};

describe('AnalyticsRetentionPage', () => {
  it('渲染同期群人数与每日留存行；rate null → —', async () => {
    getRetentionMock.mockResolvedValue(DATA);

    render(
      <MemoryRouter>
        <AnalyticsRetentionPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('retention-cohort')).toHaveTextContent('12');
    expect(screen.getByTestId('retention-day-1').textContent).toContain('50%');
    expect(screen.getByTestId('retention-day-7').textContent).toContain('25%');
    expect(screen.getByTestId('retention-day-30').textContent).toContain('—');
    // 挂载即按默认日期（30 天前，YYYY-MM-DD）拉取
    expect(getRetentionMock).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('days 为空 → 「暂无数据」', async () => {
    getRetentionMock.mockResolvedValue({ ...DATA, days: [] });

    render(
      <MemoryRouter>
        <AnalyticsRetentionPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('暂无数据')).toBeInTheDocument();
  });
});
