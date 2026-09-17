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

  it('只有 en_vocabulary 的三档限每日 2 次，其余一律不限', () => {
    const limited = DEFAULT_RULES.filter((r) => r.dailyLimit !== null);
    expect(limited).toHaveLength(3);
    expect(limited.every((r) => r.taskCode === 'en_vocabulary')).toBe(true);
    expect(limited.every((r) => r.dailyLimit === 2)).toBe(true);
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
});
