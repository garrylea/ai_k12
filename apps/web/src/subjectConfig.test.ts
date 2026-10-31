import { describe, expect, it } from 'vitest';
import {
  getTrainingSubject, isMathLikeSubject, parseSubjectId, selfAssessEligible,
  subjectHomePath, subjectName, TRAINING_SUBJECTS,
  SUBJECT_CHEMISTRY, SUBJECT_CHINESE, SUBJECT_ENGLISH, SUBJECT_MATH, SUBJECT_PHYSICS, SUBJECT_POLITICS,
} from './subjectConfig';

describe('TRAINING_SUBJECTS', () => {
  it('六科按 1/2/3/4/5/9 排列，只有道法未开放', () => {
    expect(TRAINING_SUBJECTS.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 9]);
    expect(TRAINING_SUBJECTS.filter((s) => !s.enabled).map((s) => s.id)).toEqual([9]);
    expect(getTrainingSubject(9)?.badge).toBe('内容准备中');
  });

  it('物理题型含计算，化学/道法不含', () => {
    const values = (id: number) => (getTrainingSubject(id)?.typeOptions ?? []).map((o) => o.value);
    expect(values(SUBJECT_PHYSICS)).toContain('calculation');
    expect(values(SUBJECT_CHEMISTRY)).not.toContain('calculation');
    expect(values(SUBJECT_POLITICS)).not.toContain('calculation');
  });
});

describe('学科辅助函数', () => {
  it('parseSubjectId 识别 4/5/9，未知回落数学', () => {
    expect(parseSubjectId('4')).toBe(4);
    expect(parseSubjectId('5')).toBe(5);
    expect(parseSubjectId('9')).toBe(9);
    expect(parseSubjectId('6')).toBe(SUBJECT_MATH);
    expect(parseSubjectId(null)).toBe(SUBJECT_MATH);
  });

  it('subjectName', () => {
    expect(subjectName(SUBJECT_PHYSICS)).toBe('物理');
    expect(subjectName(SUBJECT_CHEMISTRY)).toBe('化学');
    expect(subjectName(SUBJECT_POLITICS)).toBe('道德与法治');
    expect(subjectName(SUBJECT_MATH)).toBe('数学');
  });

  it('subjectHomePath：数学不带参，物理带 subjectId，语文/英语走专项页', () => {
    expect(subjectHomePath(SUBJECT_MATH)).toBe('/student/training/home');
    expect(subjectHomePath(SUBJECT_CHINESE)).toBe('/student/training/chinese/special');
    expect(subjectHomePath(SUBJECT_ENGLISH)).toBe('/student/training/english/vocabulary');
    expect(subjectHomePath(SUBJECT_PHYSICS)).toBe('/student/training/home?subjectId=4');
  });

  it('isMathLikeSubject：1/4/5 true，2/3/9 false', () => {
    expect([1, 2, 3, 4, 5, 9].map(isMathLikeSubject)).toEqual([true, false, false, true, true, false]);
  });
});

describe('selfAssessEligible（闸门③）', () => {
  it('数学只放 short_answer/proof（与今天一致）', () => {
    expect(selfAssessEligible(SUBJECT_MATH, 'short_answer')).toBe(true);
    expect(selfAssessEligible(SUBJECT_MATH, 'fill_blank')).toBe(false);
    expect(selfAssessEligible(SUBJECT_MATH, 'calculation')).toBe(false);
  });

  it('非数学学科非客观题全部走自评（含语文填空）', () => {
    expect(selfAssessEligible(SUBJECT_CHINESE, 'fill_blank')).toBe(true);
    expect(selfAssessEligible(SUBJECT_CHEMISTRY, 'fill_blank')).toBe(true);
    expect(selfAssessEligible(SUBJECT_PHYSICS, 'calculation')).toBe(true);
    expect(selfAssessEligible(SUBJECT_POLITICS, 'short_answer')).toBe(true);
  });

  it('客观题任何学科都不自评', () => {
    for (const id of [1, 2, 3, 4, 5, 9]) {
      expect(selfAssessEligible(id, 'choice')).toBe(false);
      expect(selfAssessEligible(id, 'true_false')).toBe(false);
    }
  });
});
