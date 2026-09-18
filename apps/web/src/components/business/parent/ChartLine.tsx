import { useLayoutEffect, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { readChartColor } from './chart-theme';

export interface ChartPoint {
  label: string;
  value: number;
}

export interface ChartLineProps {
  points: ChartPoint[];
  height?: number;
  /** CSS 变量名，默认家长主色。**不要**直接传颜色字面量。 */
  colorToken?: string;
  emptyText?: string;
}

const DEFAULT_HEIGHT = 220;

/**
 * 折线图薄封装（spec §5.3）。
 *
 * 三条约束：① 页面不直接依赖 recharts API；② 配色只走 CSS 变量、**不用 recharts 默认色板**；
 * ③ 不做渐变填充、不做装饰（硬规则「不用装饰元素」）。
 *
 * 取色必须在**挂载后**读：首次 render 时 `wrapRef.current` 还是 null，读不到容器上的变量。
 */
export default function ChartLine({
  points,
  height = DEFAULT_HEIGHT,
  colorToken = '--brand-500',
  emptyText = '暂无数据',
}: ChartLineProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [line, setLine] = useState(() => readChartColor(colorToken, null));
  const [grid, setGrid] = useState(() => readChartColor('--bg-subtle', null));
  const [axis, setAxis] = useState(() => readChartColor('--text-tertiary', null));

  useLayoutEffect(() => {
    const el = wrapRef.current;
    setLine(readChartColor(colorToken, el));
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
        <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
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
          <Line
            type="monotone"
            dataKey="value"
            stroke={line}
            strokeWidth={2}
            dot={{ r: 3, fill: line }}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
