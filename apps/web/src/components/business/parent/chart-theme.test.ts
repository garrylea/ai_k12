import { describe, it, expect, afterEach } from 'vitest';
import { readChartColor, CHART_FALLBACK } from './chart-theme';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('readChartColor', () => {
  it('从最近的 [data-theme] 容器读变量（家长主题挂容器上，不在 :root）', () => {
    document.body.innerHTML =
      '<div data-theme="parent" style="--brand-500: #2563EB"><span id="inner"></span></div>';
    const container = document.querySelector('[data-theme="parent"]');
    const inner = document.getElementById('inner');

    expect(readChartColor('--brand-500', inner)).toBe('#2563EB');
    expect(readChartColor('--brand-500', container)).toBe('#2563EB');
  });

  it('变量缺失 → 回落兜底值（不是空串 / 黑色）', () => {
    document.body.innerHTML = '<div data-theme="parent"><span id="inner"></span></div>';

    expect(readChartColor('--brand-500', document.getElementById('inner'))).toBe(
      CHART_FALLBACK['--brand-500'],
    );
  });

  it('容器为 null 也不抛（组件可能还没挂载）', () => {
    expect(readChartColor('--brand-500', null)).toBe(CHART_FALLBACK['--brand-500']);
  });
});
