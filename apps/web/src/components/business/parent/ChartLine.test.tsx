import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { CSSProperties, ReactNode } from 'react';
import ChartLine from './ChartLine';

/**
 * 这里 mock 掉 recharts 本体：jsdom 里 `ResponsiveContainer` 量到 0 尺寸、SVG 不真渲染，
 * 断言「图上画了什么」既脆又假。改为断言**我们传给 recharts 的 props**——那才是本封装的
 * 职责（数据、系列、颜色、标签映射）。
 */
const lineProps = vi.fn();
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="chart-container">{children}</div>
  ),
  LineChart: (props: { children?: ReactNode }) => {
    lineProps(props);
    return <div data-testid="line-chart">{props.children}</div>;
  },
  Line: ({ stroke }: { stroke?: string }) => (
    <div data-testid="line-series" data-stroke={stroke} />
  ),
  XAxis: ({ dataKey }: { dataKey?: string }) => <div data-testid="x-axis" data-key={dataKey} />,
  YAxis: () => <div data-testid="y-axis" />,
  Tooltip: () => <div data-testid="tooltip" />,
  CartesianGrid: ({ stroke }: { stroke?: string }) => (
    <div data-testid="grid" data-stroke={stroke} />
  ),
}));

afterEach(() => {
  cleanup();
  lineProps.mockReset();
});

describe('ChartLine', () => {
  it('把 points 映射成 label/value 并交给 recharts', () => {
    render(
      <div data-theme="parent">
        <ChartLine points={[{ label: '09-15', value: 70 }, { label: '09-16', value: 81.8 }]} />
      </div>,
    );

    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
    expect(lineProps).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          { label: '09-15', value: 70 },
          { label: '09-16', value: 81.8 },
        ],
      }),
    );
    expect(screen.getByTestId('x-axis')).toHaveAttribute('data-key', 'label');
  });

  it('空数据 → 渲染空态文案，不渲染图表', () => {
    render(
      <div data-theme="parent">
        <ChartLine points={[]} emptyText="本期还没有记录" />
      </div>,
    );

    expect(screen.getByText('本期还没有记录')).toBeInTheDocument();
    expect(screen.queryByTestId('line-chart')).not.toBeInTheDocument();
  });

  it('series 颜色取自容器上的 CSS 变量（不是 recharts 默认色板）', () => {
    render(
      <div data-theme="parent" style={{ '--brand-500': '#2563EB' } as CSSProperties}>
        <ChartLine points={[{ label: 'a', value: 1 }]} colorToken="--brand-500" />
      </div>,
    );

    const stroke = screen.getByTestId('line-series').getAttribute('data-stroke');
    expect(stroke).toBeTruthy();
    expect(stroke).not.toBe('#8884d8'); // recharts 默认紫
  });

  it('颜色真的取自容器上的变量值（不是只吃兜底值）', () => {
    render(
      <div data-theme="parent" style={{ '--brand-500': '#123456' } as CSSProperties}>
        <ChartLine points={[{ label: 'a', value: 1 }]} colorToken="--brand-500" />
      </div>,
    );

    expect(screen.getByTestId('line-series')).toHaveAttribute('data-stroke', '#123456');
  });
});
