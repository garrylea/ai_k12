import { describe, expect, it } from 'vitest';
import {
  HEAT_ALPHA,
  NEUTRAL_HEAT,
  heatForLevel,
  heatForNode,
  isDashedBorder,
  summarizeParent,
} from './weak-point-heat';

describe('heatForLevel', () => {
  it('level 0–5 取对应不透明度，色相固定为 brand 橘红', () => {
    for (let level = 0; level <= 5; level++) {
      const style = heatForLevel(level);
      expect(style.background).toBe(`rgba(255, 107, 53, ${HEAT_ALPHA[level]})`);
    }
  });

  it('越弱越深：level 0 比 level 5 实', () => {
    expect(HEAT_ALPHA[0]).toBeGreaterThan(HEAT_ALPHA[5]);
  });

  it('高不透明度用白字、低不透明度用正文色（对比度）', () => {
    expect(heatForLevel(0).color).toBe('#ffffff');
    expect(heatForLevel(5).color).toBe('var(--text-primary)');
  });

  it('越界 level 夹到 0–5，不产生 undefined 颜色', () => {
    expect(heatForLevel(-3).background).toBe(heatForLevel(0).background);
    expect(heatForLevel(99).background).toBe(heatForLevel(5).background);
    // 2.6 → 3（四舍五入到最近档）
    expect(heatForLevel(2.6).background).toBe(heatForLevel(3).background);
  });

  it('NaN 兜底到 level 0，不产出 undefined 颜色（畸形载荷防线）', () => {
    expect(heatForLevel(NaN).background).toBe(heatForLevel(0).background);
    expect(heatForLevel(NaN).background).not.toContain('undefined');
  });

  it('±Infinity 仍走夹取（守卫只拦 NaN，不反转无穷的语义）', () => {
    expect(heatForLevel(Infinity).background).toBe(heatForLevel(5).background);
    expect(heatForLevel(-Infinity).background).toBe(heatForLevel(0).background);
  });
});

describe('heatForNode', () => {
  it('none（从未作答）→ 中性灰，即使 level 是 0', () => {
    expect(heatForNode({ confidence: 'none', level: null })).toEqual(NEUTRAL_HEAT);
    expect(heatForNode({ confidence: 'none', level: 0 })).toEqual(NEUTRAL_HEAT);
  });

  it('insufficient（样本 < 5）→ 中性灰，即使 level 是 5', () => {
    expect(heatForNode({ confidence: 'insufficient', level: 5 })).toEqual(NEUTRAL_HEAT);
  });

  it('ok → 按 level 着色', () => {
    expect(heatForNode({ confidence: 'ok', level: 2 })).toEqual(heatForLevel(2));
  });

  it('ok 但 level 为 null 时兜底 level 0（不崩）', () => {
    expect(heatForNode({ confidence: 'ok', level: null })).toEqual(heatForLevel(0));
  });
});

describe('isDashedBorder', () => {
  it('只有 insufficient 用虚线边（区分「有结论但浅」与「没结论」）', () => {
    expect(isDashedBorder('insufficient')).toBe(true);
    expect(isDashedBorder('none')).toBe(false);
    expect(isDashedBorder('ok')).toBe(false);
  });
});

describe('summarizeParent', () => {
  it('只看有结论（ok）的子项；取最弱 level 作汇总色', () => {
    const result = summarizeParent([
      { confidence: 'ok', level: 4 },
      { confidence: 'ok', level: 1 },
      { confidence: 'none', level: null },
      { confidence: 'insufficient', level: 5 },
    ]);

    expect(result.weakestLevel).toBe(1);
    // level ≤ 2 记待补：只有 level 1 那个
    expect(result.pendingCount).toBe(1);
  });

  it('无任何 ok 子项 → weakestLevel null、pendingCount 0（一级行显示「未开始」）', () => {
    const result = summarizeParent([
      { confidence: 'none', level: null },
      { confidence: 'insufficient', level: 3 },
    ]);

    expect(result.weakestLevel).toBeNull();
    expect(result.pendingCount).toBe(0);
  });

  it('空数组不崩', () => {
    expect(summarizeParent([])).toEqual({ weakestLevel: null, pendingCount: 0 });
  });
});
