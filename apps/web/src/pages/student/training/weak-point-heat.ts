/**
 * 薄弱点图谱的**热力梯度唯一实现**。
 *
 * 为什么抽成模块：一级行汇总色、二级 chip、详情栏三处都要着色，内联就会各算一遍、
 * 改一处漏一处（本仓既有教训：`point-tiers.ts` 的注释里记着同类问题）。
 *
 * 语义：`level` 0（最弱）→ 5（最强），**越弱越深**，让薄弱点跳出来。
 * 色相固定为 brand 橘红（`#ff6b35` = `--brand-500`），只调不透明度——
 * 这样不引入第二套配色（`style.md` §2 硬约束），且日/夜间主题下都读得通。
 */
import type { MasteryConfidence } from '@/services/api';

/** `--brand-500` 的 RGB 分量；改品牌色时必须同步这里（唯一硬编码点）。 */
const BRAND_RGB = '255, 107, 53';

/** level 0→5 对应的 brand 不透明度（越弱越实）。 */
export const HEAT_ALPHA: readonly number[] = [1, 0.82, 0.64, 0.46, 0.28, 0.14];

/** 达到该不透明度及以上用白字，否则用正文色（保证对比度）。 */
const WHITE_TEXT_THRESHOLD = 0.6;

export interface HeatStyle {
  background: string;
  color: string;
}

/** 未作答 / 样本不足的中性表现（灰底灰字）。 */
export const NEUTRAL_HEAT: HeatStyle = {
  background: 'var(--bg-subtle)',
  color: 'var(--text-tertiary)',
};

/** 由 level 取热力样式；level 越界或非整数一律夹/四舍五入到 0–5。 */
export function heatForLevel(level: number): HeatStyle {
  // NaN 单独兜底：`Math.round(NaN)` → NaN 会一路穿透到 `HEAT_ALPHA[NaN]` === undefined，
  // 产出 `rgba(255, 107, 53, undefined)` 这种非法颜色（畸形载荷防线）。
  // **只拦 NaN，不用 `Number.isFinite`**——±Infinity 走下面的夹取本就正确
  // （+∞→5、-∞→0），换成 isFinite 会把它反转成 0，语义反而错。
  const clamped = Number.isNaN(level) ? 0 : Math.min(5, Math.max(0, Math.round(level)));
  const alpha = HEAT_ALPHA[clamped];
  return {
    background: `rgba(${BRAND_RGB}, ${alpha})`,
    color: alpha >= WHITE_TEXT_THRESHOLD ? '#ffffff' : 'var(--text-primary)',
  };
}

/**
 * 节点热力样式：`confidence` 决定「有没有结论」，`level` 决定深浅。
 *
 * - `none`（从未作答）→ 中性灰
 * - `insufficient`（样本 < 5）→ 中性灰（虚线边由 `isDashedBorder` 另行给出）
 * - `ok` → 按 level 着色
 *
 * **`confidence` 由后端算好**，这里只做映射，不重算阈值。
 */
export function heatForNode(node: {
  confidence: MasteryConfidence;
  level: number | null;
}): HeatStyle {
  if (node.confidence !== 'ok') return NEUTRAL_HEAT;
  return heatForLevel(node.level ?? 0);
}

/** 样本不足（`insufficient`）用虚线边，与「有结论但浅」区分开。 */
export function isDashedBorder(confidence: MasteryConfidence): boolean {
  return confidence === 'insufficient';
}

/** 「待补」的 level 上界：`level <= 2`（掌握度 < 60%）。纯展示口径，不参与推荐算法。 */
const WEAK_LEVEL_MAX = 2;

/**
 * 一级行的汇总：只统计**有结论**（`ok`）的子项。
 *
 * - `weakestLevel` = 子项里最弱的 level（汇总色块用）；无 `ok` 子项 → null（一级行显示「未开始」）
 * - `pendingCount` = `ok` 子项里 `level <= WEAK_LEVEL_MAX` 的个数（「N 个待补」）
 *
 * `insufficient` 与 `none` **都不计入**任何一边：前者没结论、后者没做过，
 * 混进来会让「待补」数字失去意义（spec §6.4：不假装有数据）。
 */
export function summarizeParent(
  children: Array<{ confidence: MasteryConfidence; level: number | null }>,
): { weakestLevel: number | null; pendingCount: number } {
  const concluded = children.filter((c) => c.confidence === 'ok');
  if (concluded.length === 0) return { weakestLevel: null, pendingCount: 0 };
  const levels = concluded.map((c) => c.level ?? 0);
  return {
    weakestLevel: Math.min(...levels),
    pendingCount: levels.filter((l) => l <= WEAK_LEVEL_MAX).length,
  };
}
