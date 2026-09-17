import { describe, it, expect } from 'vitest';
import { DEFAULT_RULES, TASK_NAMES } from './default-rules.js';

const tiersOf = (taskCode: string) =>
  DEFAULT_RULES.filter((r) => r.taskCode === taskCode).map((r) => r.tierKey);

describe('DEFAULT_RULES', () => {
  it('共 15 行', () => {
    expect(DEFAULT_RULES).toHaveLength(15);
  });

  it('(taskCode, tierKey) 组合唯一（point_rules 的唯一键，重复会 INSERT IGNORE 静默丢行）', () => {
    const keys = DEFAULT_RULES.map((r) => `${r.taskCode}/${r.tierKey}`);
    expect(new Set(keys).size).toBe(DEFAULT_RULES.length);
  });

  it('sortOrder 唯一', () => {
    const orders = DEFAULT_RULES.map((r) => r.sortOrder);
    expect(new Set(orders).size).toBe(DEFAULT_RULES.length);
  });

  it('每个 taskCode 都在 TASK_NAMES 里，且行内 taskName 与之一致', () => {
    for (const rule of DEFAULT_RULES) {
      expect(TASK_NAMES[rule.taskCode]).toBeTruthy();
      expect(rule.taskName).toBe(TASK_NAMES[rule.taskCode]);
    }
  });

  it('有每日上限的只有两类任务：math_targeted 四档共用 5 次、en_vocabulary 三档共用 2 次', () => {
    const limited = DEFAULT_RULES.filter((r) => r.dailyLimit !== null);
    expect(limited).toHaveLength(7);
    expect(limited.filter((r) => r.taskCode === 'math_targeted').every((r) => r.dailyLimit === 5)).toBe(true);
    expect(limited.filter((r) => r.taskCode === 'math_targeted')).toHaveLength(4);
    expect(limited.filter((r) => r.taskCode === 'en_vocabulary').every((r) => r.dailyLimit === 2)).toBe(true);
    expect(limited.filter((r) => r.taskCode === 'en_vocabulary')).toHaveLength(3);
    // 其余任务一律不限（甲类靠判题函数天然的一次性目标物防刷，不需要日上限）
    expect(limited.every((r) => r.taskCode === 'math_targeted' || r.taskCode === 'en_vocabulary')).toBe(true);
  });

  it('math_targeted 四档各有每日上限（档位由学生自选 + 幂等键按会话，无上限可无限刷 10 档 35 分）', () => {
    const rows = DEFAULT_RULES.filter((r) => r.taskCode === 'math_targeted');
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.dailyLimit === 5)).toBe(true);
  });

  it('math_targeted 四档 1/3/5/10', () => {
    expect(tiersOf('math_targeted')).toEqual(['1', '3', '5', '10']);
  });

  it('en_vocabulary 三档 10/15/20', () => {
    expect(tiersOf('en_vocabulary')).toEqual(['10', '15', '20']);
  });

  it('两个语文专项各按体裁分 poem / prose 两档', () => {
    expect(tiersOf('cn_dictation')).toEqual(['poem', 'prose']);
    expect(tiersOf('cn_interpretation')).toEqual(['poem', 'prose']);
  });

  it('其余任务只有 default 一档', () => {
    for (const code of ['mainline_lesson', 'math_paper', 'error_fix', 'cn_meaning']) {
      expect(tiersOf(code)).toEqual(['default']);
    }
  });

  it('全表 15 行黄金值（taskCode/tierKey/points/dailyLimit，Task 4 发币直接读 points）', () => {
    expect(DEFAULT_RULES.map((r) => [r.taskCode, r.tierKey, r.points, r.dailyLimit])).toEqual([
      ['mainline_lesson', 'default', 10, null],
      ['math_paper', 'default', 50, null],
      ['math_targeted', '1', 2, 5],
      ['math_targeted', '3', 8, 5],
      ['math_targeted', '5', 15, 5],
      ['math_targeted', '10', 35, 5],
      ['error_fix', 'default', 3, null],
      ['cn_dictation', 'poem', 2, null],
      ['cn_dictation', 'prose', 5, null],
      ['cn_interpretation', 'poem', 3, null],
      ['cn_interpretation', 'prose', 6, null],
      ['cn_meaning', 'default', 4, null],
      ['en_vocabulary', '10', 2, 2],
      ['en_vocabulary', '15', 4, 2],
      ['en_vocabulary', '20', 7, 2],
    ]);
  });
});
