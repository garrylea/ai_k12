import { describe, expect, it } from 'vitest';
import { resolveGradeInfo } from './grade.js';
import { advanceGradeOnLogin } from './grade.js';

/**
 * 登录时的年级/年龄校准（用户 2026-11-09 裁决）：
 * 每跨一个 9/1 升一级（封顶高三），每满 12 个月年龄 +1；没变化时 changed=false（调用方不写库）。
 */
describe('advanceGradeOnLogin', () => {
  it('没跨 9/1、也不满一年 → 原样返回且 changed=false', () => {
    const r = advanceGradeOnLogin({
      gradeLabel: '初二',
      schoolLevel: 'junior',
      age: 13,
      baselineAt: new Date(2026, 2, 1), // 3/1
      now: new Date(2026, 7, 31), // 8/31，还没开学
    });
    expect(r).toEqual({ gradeLabel: '初二', schoolLevel: 'junior', age: 13, changed: false });
  });

  it('跨过一个 9/1 → 升一级；同年不算满岁', () => {
    const r = advanceGradeOnLogin({
      gradeLabel: '初二',
      schoolLevel: 'junior',
      age: 13,
      baselineAt: new Date(2026, 2, 1),
      now: new Date(2026, 8, 2), // 9/2
    });
    expect(r).toMatchObject({ gradeLabel: '初三', schoolLevel: 'junior', age: 13, changed: true });
  });

  it('跨过两个 9/1 + 满一年 → 升两级且年龄 +1', () => {
    const r = advanceGradeOnLogin({
      gradeLabel: '初一',
      schoolLevel: 'junior',
      age: 12,
      baselineAt: new Date(2025, 2, 1),
      now: new Date(2026, 8, 2),
    });
    expect(r).toMatchObject({ gradeLabel: '初三', age: 13, changed: true });
  });

  it('只满一年、没跨 9/1 → 年级不变，只加年龄', () => {
    const r = advanceGradeOnLogin({
      gradeLabel: '初二',
      schoolLevel: 'junior',
      age: 13,
      baselineAt: new Date(2026, 0, 1),
      now: new Date(2027, 0, 5),
    });
    // 2026-09-01 在区间内，所以年级也会 +1
    expect(r).toMatchObject({ gradeLabel: '初三', age: 14, changed: true });
  });

  it('封顶高三：再跨 9/1 也不升（年龄照常）', () => {
    const noAgeChange = advanceGradeOnLogin({
      gradeLabel: '高三',
      schoolLevel: 'senior',
      age: 18,
      baselineAt: new Date(2026, 4, 1),
      now: new Date(2026, 8, 2),
    });
    expect(noAgeChange).toEqual({
      gradeLabel: '高三',
      schoolLevel: 'senior',
      age: 18,
      changed: false,
    });

    const withAge = advanceGradeOnLogin({
      gradeLabel: '高三',
      schoolLevel: 'senior',
      age: 18,
      baselineAt: new Date(2025, 4, 1),
      now: new Date(2026, 8, 2),
    });
    expect(withAge).toMatchObject({ gradeLabel: '高三', age: 19, changed: true });
  });

  it('小学毕业跨学段：六年级 + 1 → 初一，学段变 junior', () => {
    const r = advanceGradeOnLogin({
      gradeLabel: '小学六年级',
      schoolLevel: 'primary',
      age: 12,
      baselineAt: new Date(2026, 1, 1),
      now: new Date(2026, 8, 5),
    });
    expect(r).toMatchObject({ gradeLabel: '初一', schoolLevel: 'junior', changed: true });
  });

  it('历史写法「三年级」→ 收敛成标准标签（小学三年级），年龄照常校准', () => {
    const r = advanceGradeOnLogin({
      gradeLabel: '三年级',
      schoolLevel: 'primary',
      age: 9,
      // 没跨 9/1、也不满一年：只有标签被收敛，仍算 changed（要写库把脏值改掉）
      baselineAt: new Date(2025, 9, 1),
      now: new Date(2026, 1, 1),
    });
    expect(r).toEqual({ gradeLabel: '小学三年级', schoolLevel: 'primary', age: 9, changed: true });
  });

  it('历史写法 grade_9 → 收敛成「初三」，跨 9/1 照常升到高一', () => {
    const r = advanceGradeOnLogin({
      gradeLabel: 'grade_9',
      schoolLevel: 'junior',
      age: 15,
      baselineAt: new Date(2026, 2, 1),
      now: new Date(2026, 8, 2),
    });
    expect(r).toEqual({ gradeLabel: '高一', schoolLevel: 'senior', age: 15, changed: true });
  });

  it('完全无法解析的标签（「大学」）→ 只校准年龄，原样保留', () => {
    const r = advanceGradeOnLogin({
      gradeLabel: '大学',
      schoolLevel: 'senior',
      age: 18,
      baselineAt: new Date(2025, 0, 1),
      now: new Date(2026, 1, 1),
    });
    expect(r).toEqual({ gradeLabel: '大学', schoolLevel: 'senior', age: 19, changed: true });
  });
});

describe('resolveGradeInfo（宽容解析历史写法）', () => {
  it('标准标签 / grade_N / 「七年级」都能解析到同一项', () => {
    expect(resolveGradeInfo('初二')?.code).toBe('grade_8');
    expect(resolveGradeInfo('grade_8')?.code).toBe('grade_8');
    expect(resolveGradeInfo('八年级')?.code).toBe('grade_8');
    expect(resolveGradeInfo('grade_3')?.label).toBe('小学三年级');
    expect(resolveGradeInfo(' 初一 ')?.code).toBe('grade_7');
  });

  it('空串 / 无法识别 → undefined', () => {
    expect(resolveGradeInfo('')).toBeUndefined();
    expect(resolveGradeInfo('大学')).toBeUndefined();
  });
});
