import { afterEach, describe, expect, it, vi } from 'vitest';
import { selfAssessSkipsJudging } from '../../common/subject-config.js';
import { shouldSelfAssess } from '../exams/exams.service.js';

describe('英语自评不依赖部署环境', () => {
  const old = process.env.JUDGE_SUBJECTIVE_MODE;
  afterEach(() => {
    if (old === undefined) delete process.env.JUDGE_SUBJECTIVE_MODE;
    else process.env.JUDGE_SUBJECTIVE_MODE = old;
    vi.restoreAllMocks();
  });
  it('JUDGE_SUBJECTIVE_MODE=ai 时英语 short_answer 仍自评', () => {
    process.env.JUDGE_SUBJECTIVE_MODE = 'ai';
    expect(selfAssessSkipsJudging(3, 'short_answer')).toBe(true);
    expect(shouldSelfAssess(3, 'short_answer')).toBe(true);
  });
  it('choice 仍走 exact', () => {
    process.env.JUDGE_SUBJECTIVE_MODE = 'ai';
    expect(shouldSelfAssess(3, 'choice')).toBe(false);
  });
});
