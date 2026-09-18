import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { CSSProperties, ReactNode } from 'react';
import ChartBar from './ChartBar';

const barProps = vi.fn();
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="chart-container">{children}</div>
  ),
  BarChart: (props: { children?: ReactNode }) => {
    barProps(props);
    return <div data-testid="bar-chart">{props.children}</div>;
  },
  Bar: ({ fill }: { fill?: string }) => <div data-testid="bar-series" data-fill={fill} />,
  XAxis: ({ dataKey }: { dataKey?: string }) => <div data-testid="x-axis" data-key={dataKey} />,
  YAxis: () => <div data-testid="y-axis" />,
  Tooltip: () => <div data-testid="tooltip" />,
  CartesianGrid: ({ stroke }: { stroke?: string }) => (
    <div data-testid="grid" data-stroke={stroke} />
  ),
}));

afterEach(() => {
  cleanup();
  barProps.mockReset();
});

describe('ChartBar', () => {
  it('把 points 交给 recharts，X 轴用 label', () => {
    render(
      <div data-theme="parent">
        <ChartBar points={[{ label: '数学', value: 73.8 }]} />
      </div>,
    );

    expect(barProps).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ label: '数学', value: 73.8 }] }),
    );
    expect(screen.getByTestId('x-axis')).toHaveAttribute('data-key', 'label');
  });

  it('空数据 → 空态文案', () => {
    render(
      <div data-theme="parent">
        <ChartBar points={[]} emptyText="本期还没有记录" />
      </div>,
    );

    expect(screen.getByText('本期还没有记录')).toBeInTheDocument();
    expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
  });

  it('series 颜色取自 CSS 变量', () => {
    render(
      <div data-theme="parent" style={{ '--brand-500': '#2563EB' } as CSSProperties}>
        <ChartBar points={[{ label: 'a', value: 1 }]} colorToken="--brand-500" />
      </div>,
    );

    const fill = screen.getByTestId('bar-series').getAttribute('data-fill');
    expect(fill).toBeTruthy();
    expect(fill).not.toBe('#8884d8');
  });

  it('颜色真的取自容器上的变量值（不是只吃兜底值）', () => {
    render(
      <div data-theme="parent" style={{ '--brand-500': '#123456' } as CSSProperties}>
        <ChartBar points={[{ label: 'a', value: 1 }]} colorToken="--brand-500" />
      </div>,
    );

    expect(screen.getByTestId('bar-series')).toHaveAttribute('data-fill', '#123456');
  });
});
