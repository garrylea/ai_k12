/**
 * 图表取色（spec §5.3）。
 *
 * **必须从最近的 `[data-theme]` 容器读，不能用 `document.documentElement`**：家长主题
 * （`--brand-500: #2563EB` 商务蓝）定义在 `[data-theme="parent"]` 容器上，而 `:root` 是学生端
 * 日间值（`--brand-500: #ff6b35` 橙）——从根元素读会画出橙色的家长图表。
 *
 * 为什么要有兜底值：`getComputedStyle` 在没有 CSS 环境（jsdom 测试）下返回空串，变量缺失时
 * 图表会静默变成默认黑线——比报错更难发现。兜底值与 `style.md` §2.3 家长主题一致。
 */
export const CHART_FALLBACK: Record<string, string> = {
  '--brand-500': '#2563EB',
  '--brand-400': '#3B82F6',
  '--success': '#10B981',
  '--error': '#DC2626',
  '--text-tertiary': '#9CA3AF',
  '--bg-subtle': '#E5E9F0',
};

/** 从 `container` 向上找最近的 `[data-theme]`，取其上的 CSS 变量真实值。 */
export function readChartColor(token: string, container: Element | null): string {
  const themed = container?.closest('[data-theme]') ?? null;
  if (themed) {
    const value = getComputedStyle(themed).getPropertyValue(token).trim();
    if (value) return value;
  }
  return CHART_FALLBACK[token] ?? '#000000';
}
