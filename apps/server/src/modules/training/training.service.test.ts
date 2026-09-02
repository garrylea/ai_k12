import { describe, it, expect, vi } from 'vitest';
import { TrainingService } from './training.service';
import { TrainingController } from './training.controller';

const mk = (overrides: any = {}) => ({
  mainErrorRepo: {
    findErrorBookEntries: vi.fn().mockResolvedValue([]),
    bumpLevels: vi.fn().mockResolvedValue(undefined),
  },
  judgeCore: { judgeQuestion: vi.fn() },
  questionsRepo: { findById: vi.fn(), findRandomByKpAndType: vi.fn().mockResolvedValue([]) },
  // Task 3（提示端点）依赖：占位，getHint 测试里按需覆盖。
  questionHintsRepo: {
    findByQuestionId: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
  },
  hint: { generate: vi.fn() },
  // Task 8（专项练习）依赖。
  knowledgePointsRepo: { findBySubject: vi.fn().mockResolvedValue([]) },
  ...overrides,
});
const mkSvc = (deps: ReturnType<typeof mk>) =>
  new TrainingService(deps.mainErrorRepo, deps.judgeCore, deps.questionsRepo, deps.knowledgePointsRepo, deps.questionHintsRepo, deps.hint);

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

describe('TrainingService.getKnowledgePoints', () => {
  it('透传 subjectId 给 repo，平铺列表原样返回（树形组装放前端）', async () => {
    const flat = [
      { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
      { id: 2, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
    ];
    const deps = mk({ knowledgePointsRepo: { findBySubject: vi.fn().mockResolvedValue(flat) } });
    const r = await mkSvc(deps).getKnowledgePoints(1);
    expect(deps.knowledgePointsRepo.findBySubject).toHaveBeenCalledWith(1);
    expect(r).toEqual(flat);
  });
});

describe('TrainingService.startTargetedPractice', () => {
  const questionRow = {
    id: 10,
    subject_id: 1,
    type: 'choice',
    difficulty: 2,
    content: '题面文本',
    options: '["A. 1", "B. 2"]',
    answer: 'A',
    explanation: '解析内容',
    source: 'paper',
    content_hash: 'hash',
    is_active: 1,
    created_at: new Date('2026-09-01'),
  };

  it('透传抽题参数给 repo（type=null 不过滤题型）', async () => {
    const deps = mk();
    await mkSvc(deps).startTargetedPractice({ subjectId: 1, kpId: 3, type: null, count: 5 });
    expect(deps.questionsRepo.findRandomByKpAndType).toHaveBeenCalledWith(1, 3, null, 5);
  });

  it('透传非空 type', async () => {
    const deps = mk();
    await mkSvc(deps).startTargetedPractice({ subjectId: 1, kpId: 3, type: 'proof', count: 10 });
    expect(deps.questionsRepo.findRandomByKpAndType).toHaveBeenCalledWith(1, 3, 'proof', 10);
  });

  it('白名单序列化：只出 questionId/text/type/options，剥离 answer/explanation/material', async () => {
    const deps = mk({
      questionsRepo: { findRandomByKpAndType: vi.fn().mockResolvedValue([questionRow]) },
    });
    const r = await mkSvc(deps).startTargetedPractice({ subjectId: 1, kpId: 3, type: 'choice', count: 5 });
    expect(r.questions).toHaveLength(1);
    const q = r.questions[0];
    expect(q).toEqual({ questionId: 10, text: '题面文本', type: 'choice', options: ['A. 1', 'B. 2'] });
    // 白名单之外的字段一律不出（防答案泄露）
    expect(Object.keys(q).sort()).toEqual(['options', 'questionId', 'text', 'type']);
    expect(JSON.stringify(r)).not.toContain('answer');
    expect(JSON.stringify(r)).not.toContain('explanation');
  });

  it('options 为 null 时原样返回 null，不抛错', async () => {
    const deps = mk({
      questionsRepo: { findRandomByKpAndType: vi.fn().mockResolvedValue([{ ...questionRow, options: null }]) },
    });
    const r = await mkSvc(deps).startTargetedPractice({ subjectId: 1, kpId: 3, type: null, count: 5 });
    expect(r.questions[0].options).toBeNull();
  });

  it('抽不到题返回空数组（空集合非错误）', async () => {
    const deps = mk({ questionsRepo: { findRandomByKpAndType: vi.fn().mockResolvedValue([]) } });
    const r = await mkSvc(deps).startTargetedPractice({ subjectId: 1, kpId: 999, type: null, count: 5 });
    expect(r).toEqual({ questions: [] });
  });
});

describe('TrainingController.startTargetedPractice 校验', () => {
  const mkController = (service: any) => new TrainingController(service);

  it('count 越界（0 / 21 / 非整数）-> 400', async () => {
    const svc: any = { startTargetedPractice: vi.fn() };
    const c = mkController(svc);
    for (const count of [0, 21, 1.5, NaN]) {
      await expect(
        c.startTargetedPractice({ subjectId: 1, kpId: 3, type: null, count }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(svc.startTargetedPractice).not.toHaveBeenCalled();
  });

  it('type 非白名单值 -> 400', async () => {
    const svc: any = { startTargetedPractice: vi.fn() };
    const c = mkController(svc);
    await expect(
      c.startTargetedPractice({ subjectId: 1, kpId: 3, type: 'essay', count: 5 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(svc.startTargetedPractice).not.toHaveBeenCalled();
  });

  it('合法 type（含 null）与 count 1-20 透传 service', async () => {
    const svc: any = { startTargetedPractice: vi.fn().mockResolvedValue({ questions: [] }) };
    const c = mkController(svc);
    await c.startTargetedPractice({ subjectId: 1, kpId: 3, type: null, count: 1 });
    await c.startTargetedPractice({ subjectId: 1, kpId: 3, type: 'proof', count: 20 });
    expect(svc.startTargetedPractice).toHaveBeenCalledTimes(2);
    expect(svc.startTargetedPractice).toHaveBeenNthCalledWith(1, { subjectId: 1, kpId: 3, type: null, count: 1 });
    expect(svc.startTargetedPractice).toHaveBeenNthCalledWith(2, { subjectId: 1, kpId: 3, type: 'proof', count: 20 });
  });
});
