import { useLayoutEffect, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { readChartColor } from './chart-theme';
import type { ChartPoint } from './ChartLine';

export interface ChartBarProps {
  points: ChartPoint[];
  height?: number;
  colorToken?: string;
  emptyText?: string;
}

const DEFAULT_HEIGHT = 220;

/**
 * 柱状图薄封装。约束同 `ChartLine`（CSS 变量取色、无装饰、页面不碰 recharts API）。
 *
 * 取色同样在挂载后读（首次 render 时 ref 还是 null，读不到 `[data-theme]` 容器上的变量）。
 */
export default function ChartBar({
  points,
  height = DEFAULT_HEIGHT,
  colorToken = '--brand-500',
  emptyText = '暂无数据',
}: ChartBarProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState(() => readChartColor(colorToken, null));
  const [grid, setGrid] = useState(() => readChartColor('--bg-subtle', null));
  const [axis, setAxis] = useState(() => readChartColor('--text-tertiary', null));

  useLayoutEffect(() => {
    const el = wrapRef.current;
    setBar(readChartColor(colorToken, el));
    setGrid(readChartColor('--bg-subtle', el));
    setAxis(readChartColor('--text-tertiary', el));
  }, [colorToken]);

  if (points.length === 0) {
    return (
      <div
        ref={wrapRef}
        data-testid="chart-empty"
        className="flex items-center justify-center text-sm text-[var(--text-secondary)]"
        style={{ height }}
      >
        {emptyText}
      </div>
    );
  }

  return (
    <div ref={wrapRef}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
          <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" stroke={axis} tick={{ fill: axis, fontSize: 12 }} />
          <YAxis stroke={axis} tick={{ fill: axis, fontSize: 12 }} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: '#FFFFFF',
              border: `1px solid ${grid}`,
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Bar dataKey="value" fill={bar} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
