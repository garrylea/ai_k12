import { describe, it, expect, vi } from 'vitest';
import { TrainingService } from './training.service';

const mk = (overrides: any = {}) => ({
  mainErrorRepo: {
    findErrorBookEntries: vi.fn().mockResolvedValue([]),
    bumpLevels: vi.fn().mockResolvedValue(undefined),
  },
  judgeCore: { judgeQuestion: vi.fn() },
  questionsRepo: { findById: vi.fn(), findRandomByKpAndType: vi.fn() },
  // Task 3（提示端点）依赖：占位，getHint 测试里按需覆盖。
  questionHintsRepo: {
    findByQuestionId: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
  },
  hint: { generate: vi.fn() },
  ...overrides,
});
const mkSvc = (deps: ReturnType<typeof mk>) =>
  new TrainingService(deps.mainErrorRepo, deps.judgeCore, deps.questionsRepo, deps.questionHintsRepo, deps.hint);

describe('TrainingService.getErrorBookEntries', () => {
  it('透传筛选参数给 repo', async () => {
    const deps = mk();
    const svc = mkSvc(deps);
    await svc.getErrorBookEntries(1, 1, { from: '2026-09-01', type: 'choice' });
    expect(deps.mainErrorRepo.findErrorBookEntries).toHaveBeenCalledWith(1, 1, { from: '2026-09-01', type: 'choice' });
  });
  it('映射行 -> DTO（kpIds 聚合）', async () => {
    const deps = mk({
      mainErrorRepo: {
        findErrorBookEntries: vi.fn().mockResolvedValue([
          { id: 1, question_id: 10, questionText: '题面', type: 'choice', level: 2, created_at: new Date('2026-09-01'), kp_id: 3 },
          { id: 1, question_id: 10, questionText: '题面', type: 'choice', level: 2, created_at: new Date('2026-09-01'), kp_id: 5 },
        ]),
        bumpLevels: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.getErrorBookEntries(1, 1, {});
    expect(r).toHaveLength(1);
    expect(r[0].kpIds).toEqual([3, 5]);
  });
});

describe('TrainingService.judgeTraining', () => {
  it('error_practice 来源透传 JudgeCore', async () => {
    const deps = mk({ judgeCore: { judgeQuestion: vi.fn().mockResolvedValue({ questionId: 10, isCorrect: true, method: 'exact', analysis: null, errorType: null, errorBookId: undefined }) } });
    const svc = mkSvc(deps);
    await svc.judgeTraining({ studentId: 1, questionId: 10, subjectId: 1, studentAnswer: 'A', source: 'error_practice' });
    expect(deps.judgeCore.judgeQuestion).toHaveBeenCalledWith({ studentId: 1, questionId: 10, subjectId: 1, studentAnswer: 'A', source: 'error_practice', sourceRefId: null });
  });
});

describe('TrainingService.bumpErrorLevels', () => {
  it('透传 errorBookIds 给 repo.bumpLevels', async () => {
    const deps = mk();
    const svc = mkSvc(deps);
    await svc.bumpErrorLevels([1, 2, 3]);
    expect(deps.mainErrorRepo.bumpLevels).toHaveBeenCalledWith([1, 2, 3]);
  });
});

describe('TrainingService.getHint', () => {
  it('缓存命中直返，不调 AI', async () => {
    const deps = mk({
      questionHintsRepo: { findByQuestionId: vi.fn().mockResolvedValue({ hint: '旧提示' }), upsert: vi.fn() },
      hint: { generate: vi.fn() },
      questionsRepo: { findById: vi.fn().mockResolvedValue({ id: 10, content: '题面', type: 'choice' }) },
    });
    const r = await mkSvc(deps).getHint({ questionId: 10 });
    expect(r).toEqual({ hint: '旧提示', cached: true });
    expect(deps.hint.generate).not.toHaveBeenCalled();
  });

  it('未命中 -> generate + upsert + cached:false', async () => {
    const deps = mk({
      questionHintsRepo: { findByQuestionId: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue(undefined) },
      hint: { generate: vi.fn().mockResolvedValue({ content: '新提示', reasoning: null }) },
      questionsRepo: { findById: vi.fn().mockResolvedValue({ id: 10, content: '题面', type: 'choice' }) },
    });
    const r = await mkSvc(deps).getHint({ questionId: 10 });
    expect(r).toEqual({ hint: '新提示', cached: false });
    expect(deps.hint.generate).toHaveBeenCalledWith({ questionContent: '题面', subject: 'math' });
    expect(deps.questionHintsRepo.upsert).toHaveBeenCalledWith(10, '新提示');
  });

  it('upsert 失败不阻断返回（best-effort 写回）', async () => {
    const deps = mk({
      questionHintsRepo: {
        findByQuestionId: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockRejectedValue(new Error('db down')),
      },
      hint: { generate: vi.fn().mockResolvedValue({ content: '新提示', reasoning: null }) },
      questionsRepo: { findById: vi.fn().mockResolvedValue({ id: 10, content: '题面', type: 'choice' }) },
    });
    const r = await mkSvc(deps).getHint({ questionId: 10 });
    expect(r).toEqual({ hint: '新提示', cached: false });
  });

  it('generate 抛错 -> HttpException 503 code 5001', async () => {
    const deps = mk({
      hint: { generate: vi.fn().mockRejectedValue(new Error('llm down')) },
      questionsRepo: { findById: vi.fn().mockResolvedValue({ id: 10, content: '题面', type: 'choice' }) },
    });
    await expect(mkSvc(deps).getHint({ questionId: 10 })).rejects.toMatchObject({
      status: 503,
      response: { code: 5001 },
    });
    expect(deps.questionHintsRepo.upsert).not.toHaveBeenCalled();
  });

  it('题目不存在 -> 404', async () => {
    const deps = mk({
      questionsRepo: { findById: vi.fn().mockResolvedValue(null) },
    });
    await expect(mkSvc(deps).getHint({ questionId: 999 })).rejects.toMatchObject({ status: 404 });
    expect(deps.hint.generate).not.toHaveBeenCalled();
  });
});
