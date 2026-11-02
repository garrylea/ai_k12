import { describe, expect, it } from 'vitest';
import {
  isSelfAssessSubject,
  paperTaskCode,
  prefersExactBeforeSelfAssess,
  selfAssessSkipsJudging,
  subjectCodeOf,
  targetedTaskCode,
} from './subject-config.js';

describe('subject-config 任务码', () => {
  it('五科各自独立', () => {
    expect([1, 2, 4, 5, 9].map(targetedTaskCode)).toEqual([
      'math_targeted', 'cn_targeted', 'physics_targeted', 'chemistry_targeted', 'politics_targeted',
    ]);
    expect([1, 2, 4, 5, 9].map(paperTaskCode)).toEqual([
      'math_paper', 'cn_paper', 'physics_paper', 'chemistry_paper', 'politics_paper',
    ]);
  });

  it('表外学科（6/7/8/NaN）回落数学口径', () => {
    expect(targetedTaskCode(6)).toBe('math_targeted');
    expect(paperTaskCode(8)).toBe('math_paper');
    expect(targetedTaskCode(Number.NaN)).toBe('math_targeted');
  });
});

describe('subject-config 自评口径', () => {
  it('自评学科只有 2/4/5/9', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].filter(isSelfAssessSubject)).toEqual([2, 4, 5, 9]);
  });

  it('闸门①：语文非客观题跳过判题；新学科只有 short_answer/proof 跳过', () => {
    expect(selfAssessSkipsJudging(2, 'fill_blank')).toBe(true);
    expect(selfAssessSkipsJudging(2, 'choice')).toBe(false);
    expect(selfAssessSkipsJudging(4, 'short_answer')).toBe(true);
    expect(selfAssessSkipsJudging(4, 'proof')).toBe(true);
    expect(selfAssessSkipsJudging(4, 'calculation')).toBe(false);
    expect(selfAssessSkipsJudging(5, 'fill_blank')).toBe(false);
    expect(selfAssessSkipsJudging(9, 'short_answer')).toBe(true);
    expect(selfAssessSkipsJudging(1, 'short_answer')).toBe(false);
  });

  it('只有 4/5/9 先做归一化相等再自评', () => {
    expect([1, 2, 3, 4, 5, 9].filter(prefersExactBeforeSelfAssess)).toEqual([4, 5, 9]);
  });
});

describe('subject-config AI 路由档位（2026-11-01）', () => {
  it('1/2/3/4/5/9 各自成档', () => {
    expect([1, 2, 3, 4, 5, 9].map(subjectCodeOf)).toEqual([
      'math', 'chinese', 'english', 'physics', 'chemistry', 'politics',
    ]);
  });

  it('表外学科（6/7/8/NaN/null/undefined）回落 math', () => {
    for (const id of [6, 7, 8, Number.NaN, null, undefined]) {
      expect(subjectCodeOf(id as never)).toBe('math');
    }
  });
});
