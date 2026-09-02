import { describe, it, expect, vi } from 'vitest';
import { JudgeCoreService } from './judge-core.service';

const mk = (overrides: any = {}) => ({
  questionsRepo: {
    findById: vi.fn().mockResolvedValue(null),
    findByContentHash: vi.fn().mockResolvedValue(null),
    findOrCreate: vi.fn(),
    deleteById: vi.fn(),
  },
  mainErrorRepo: {
    create: vi.fn().mockResolvedValue(42),
    findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(null),
    clearUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(undefined),
  },
  structuring: { structure: vi.fn() },
  judgment: { judge: vi.fn() },
  ...overrides,
});

const mkSvc = (deps: ReturnType<typeof mk>) =>
  new JudgeCoreService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any);

describe('JudgeCoreService.judgeQuestion', () => {
  it('choice 命中 -> exact 比对，答错入错题本（source 透传）', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findByContentHash: vi.fn(),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'B', source: 'targeted' });
    expect(r.isCorrect).toBe(false);
    expect(r.method).toBe('exact');
    expect(deps.mainErrorRepo.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'targeted', question_id: 10, source_ref_id: null }));
    expect(deps.judgment.judge).not.toHaveBeenCalled();
  });

  it('答对 -> clearUnclearedByStudentQuestionId（不限 source 清零）', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findByContentHash: vi.fn(),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'A', source: 'error_practice' });
    expect(r.isCorrect).toBe(true);
    expect(deps.mainErrorRepo.clearUnclearedByStudentQuestionId).toHaveBeenCalledWith(1, 10);
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });

  it('题目不存在 -> 400（训练题必来自题库）', async () => {
    const deps = mk();
    const svc = mkSvc(deps);
    await expect(svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 999, studentAnswer: 'x', source: 'targeted' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('AI 判定失败 -> 503，不入错题本', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 10, type: 'proof', answer: '', options: null }),
        findByContentHash: vi.fn(),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
      judgment: { judge: vi.fn().mockRejectedValue(new Error('boom')) },
    });
    const svc = mkSvc(deps);
    await expect(svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'x', source: 'exam' }))
      .rejects.toMatchObject({ status: 503 });
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });
});
