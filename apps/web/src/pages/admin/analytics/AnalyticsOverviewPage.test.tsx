import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsOverviewPage from './AnalyticsOverviewPage';
import { getAdminOverview, type OverviewData } from '@/services/api';

/**
 * 图表桩：recharts 在 jsdom 里量不到尺寸、不真渲染 SVG（先例 ParentReportPage.test.tsx）。
 * 本文件只验页面的数据编排（四卡取值、空态、喂给图表的点）。
 */
vi.mock('@/components/business/parent/ChartBar', () => ({
  default: ({ points }: { points: { label: string; value: number }[] }) => (
    <div data-testid="chart-bar" data-count={points.length}>
      {points.map((p) => `${p.label}:${p.value}`).join(',')}
    </div>
  ),
}));

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getAdminOverview: vi.fn() };
});

const getOverviewMock = vi.mocked(getAdminOverview);

afterEach(() => cleanup());

const DATA: OverviewData = {
  dau: 3,
  wau: 9,
  totalSeconds: 7200,
  totalAnswers: 40,
  accuracy: 0.75,
  moduleTop: [{ module: 'mainline', students: 3, seconds: 3600 }],
};

describe('AnalyticsOverviewPage', () => {
  it('渲染四张指标卡与模块柱状图', async () => {
    getOverviewMock.mockResolvedValue(DATA);

    render(
      <MemoryRouter>
        <AnalyticsOverviewPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('card-今日活跃')).toHaveTextContent('3');
    expect(screen.getByTestId('card-周活跃')).toHaveTextContent('9');
    expect(screen.getByTestId('card-总时长')).toHaveTextContent('2 小时 0 分');
    expect(screen.getByTestId('card-正确率')).toHaveTextContent('75%');

    const chart = await screen.findByTestId('chart-bar');
    expect(chart.getAttribute('data-count')).toBe('1');
    expect(chart.textContent).toContain('mainline:3');
  });

  it('moduleTop 空 → 「暂无数据」不渲染图表；accuracy null → 正确率显示 —', async () => {
    getOverviewMock.mockResolvedValue({ ...DATA, dau: 0, wau: 0, accuracy: null, moduleTop: [] });

    render(
      <MemoryRouter>
        <AnalyticsOverviewPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('暂无数据')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-bar')).toBeNull();
    expect(screen.getByTestId('card-正确率').textContent).toContain('—');
  });
});
