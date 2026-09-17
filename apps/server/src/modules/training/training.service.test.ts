import { describe, it, expect, vi } from 'vitest';
import { TrainingService } from './training.service';
import { TrainingController } from './training.controller';
import { PointRulesService } from '../points/point-rules.service.js';
import { DEFAULT_RULES } from '../points/default-rules.js';

const mk = (overrides: any = {}) => ({
  mainErrorRepo: {
    findErrorBookEntries: vi.fn().mockResolvedValue([]),
    bumpLevels: vi.fn().mockResolvedValue(undefined),
  },
  judgeCore: { judgeQuestion: vi.fn(), recordSelfAssessment: vi.fn() },
  questionsRepo: { findById: vi.fn(), findRandomByKpAndType: vi.fn().mockResolvedValue([]) },
  questionHintsRepo: {
    findByQuestionId: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
  },
  hint: { generate: vi.fn() },
  knowledgePointsRepo: { findBySubject: vi.fn().mockResolvedValue([]) },
  // 「不再展示」repo（2026-09-04）。
  hiddenRepo: {
    mark: vi.fn().mockResolvedValue(undefined),
    unmark: vi.fn().mockResolvedValue(1),
    unmarkAll: vi.fn().mockResolvedValue(0),
    findAllByStudent: vi.fn().mockResolvedValue([]),
  },
  // 解析拉取（Task 7）+ 自评 incorrect 触发解析缓存兜底。
  explanationCache: {
    waitForExplanations: vi.fn().mockResolvedValue({}),
    waitExplanation: vi.fn().mockResolvedValue(null),
    ensureExplanation: vi.fn(),
  },
  notificationsRepo: {
    hasUnreadByQuestion: vi.fn().mockResolvedValue(false),
    create: vi.fn().mockResolvedValue(1),
  },
  // 甲类发分（Task 11）：默写/解释判题会调 award()。本文件不测发分，给个不发分的桩即可。
  pointsService: { award: vi.fn(), todayKey: vi.fn(() => '2026-09-17') },
  // 乙类整批发分（Task 12）：专项开练建会话（`training_sessions`）。
  trainingSessionsRepo: { create: vi.fn().mockResolvedValue(101) },
  ...overrides,
});
const mkSvc = (deps: ReturnType<typeof mk>) =>
  new TrainingService(
    deps.mainErrorRepo, deps.judgeCore, deps.questionsRepo, deps.knowledgePointsRepo,
    deps.questionHintsRepo, deps.hint, deps.hiddenRepo,
    deps.explanationCache, deps.notificationsRepo,
    {} as never, {} as never, {} as never,
    deps.pointsService as never,
    deps.trainingSessionsRepo as never,
  );

/**
 * 真实的 `PointRulesService` + 内存 fake 仓储：库里一条规则都没有的**全新学生**，
 * 第一次 `listTierKeys` 会先 `ensureRules` 补默认档位再查。纯 mock 掉 `listTierKeys`
 * 只能证明「控制器信了白名单」，证不了「新学生不会被空数组 400 掉」。
 */
function freshPointRules() {
  const STAMP = new Date(2026, 8, 17);
  const rows = DEFAULT_RULES.map((d, i) => ({
    id: i + 1, student_id: 9, task_code: d.taskCode, tier_key: d.tierKey,
    tier_label: d.tierLabel, points: d.points, daily_limit: d.dailyLimit,
    sort_order: d.sortOrder, is_active: 1, created_at: STAMP, updated_at: STAMP,
  }));
  let primed = false;
  const rulesRepo = {
    findByStudent: vi.fn(async () => (primed ? rows : [])),
    insertIgnoreBatch: vi.fn(async () => { primed = true; }),
    updateOne: vi.fn(),
  };
  const points = { startOfToday: vi.fn(), startOfTomorrow: vi.fn() };
  const service = new PointRulesService({} as never, rulesRepo as never, {} as never, points as never);
  return { service, rulesRepo };
}

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
          { id: 1, question_id: 10, questionText: '题面', type: 'choice', level: 2, created_at: new Date('2026-09-01'), kp_id: 3, options: '["A. 1", "B. 2"]' },
          { id: 1, question_id: 10, questionText: '题面', type: 'choice', level: 2, created_at: new Date('2026-09-01'), kp_id: 5, options: '["A. 1", "B. 2"]' },
        ]),
        bumpLevels: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.getErrorBookEntries(1, 1, {});
    expect(r).toHaveLength(1);
    expect(r[0].kpIds).toEqual([3, 5]);
  });

  it('options JSON 字符串解析进 DTO（多行聚合取首行，坏 JSON/缺省为 null）', async () => {
    const deps = mk({
      mainErrorRepo: {
        findErrorBookEntries: vi.fn().mockResolvedValue([
          { id: 1, question_id: 10, questionText: '题面', type: 'choice', level: 1, created_at: new Date('2026-09-01'), kp_id: null, options: '["A. 1", "B. 2"]' },
          { id: 2, question_id: 11, questionText: '题面2', type: 'proof', level: 1, created_at: new Date('2026-09-01'), kp_id: null, options: 'not json' },
          { id: 3, question_id: 12, questionText: '题面3', type: 'fill_blank', level: 1, created_at: new Date('2026-09-01'), kp_id: null, options: null },
        ]),
        bumpLevels: vi.fn(),
      },
    });
    const r = await mkSvc(deps).getErrorBookEntries(1, 1, {});
    expect(r[0].options).toEqual(['A. 1', 'B. 2']);
    expect(r[1].options).toBeNull();
    expect(r[2].options).toBeNull();
  });
});

describe('TrainingService.judgeTraining', () => {
  it('error_practice 来源透传 JudgeCore', async () => {
    const deps = mk({ judgeCore: { judgeQuestion: vi.fn().mockResolvedValue({ questionId: 10, isCorrect: true, method: 'exact', errorType: null, errorBookId: undefined }) } });
    const svc = mkSvc(deps);
    await svc.judgeTraining({ studentId: 1, questionId: 10, subjectId: 1, studentAnswer: 'A', source: 'error_practice' });
    expect(deps.judgeCore.judgeQuestion).toHaveBeenCalledWith({ studentId: 1, questionId: 10, subjectId: 1, studentAnswer: 'A', source: 'error_practice', sourceRefId: null });
  });
});

describe('TrainingService.selfAssess', () => {
  const userQ = { id: 10, content: '题面', type: 'short_answer' };

  it('题目不存在 -> 404，不调 JudgeCore', async () => {
    const deps = mk({ questionsRepo: { findById: vi.fn().mockResolvedValue(null) } });
    await expect(
      mkSvc(deps).selfAssess({ studentId: 1, questionId: 999, subjectId: 1, assessment: 'incorrect', source: 'targeted' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(deps.judgeCore.recordSelfAssessment).not.toHaveBeenCalled();
  });

  it('incorrect -> 调 recordSelfAssessment 并 fire-and-forget 触发 ensureExplanation', async () => {
    const deps = mk({
      questionsRepo: { findById: vi.fn().mockResolvedValue(userQ) },
      judgeCore: { recordSelfAssessment: vi.fn().mockResolvedValue({ errorBookId: 42 }) },
    });
    const r = await mkSvc(deps).selfAssess({ studentId: 1, questionId: 10, subjectId: 1, assessment: 'incorrect', source: 'targeted' });
    expect(deps.judgeCore.recordSelfAssessment).toHaveBeenCalledWith({ studentId: 1, questionId: 10, subjectId: 1, assessment: 'incorrect', source: 'targeted', sourceRefId: null });
    expect(deps.explanationCache.ensureExplanation).toHaveBeenCalledWith(userQ);
    expect(r.errorBookId).toBe(42);
  });

  it('correct -> 调 recordSelfAssessment 但不触发 ensureExplanation', async () => {
    const deps = mk({
      questionsRepo: { findById: vi.fn().mockResolvedValue(userQ) },
      judgeCore: { recordSelfAssessment: vi.fn().mockResolvedValue({ errorBookId: undefined }) },
    });
    await mkSvc(deps).selfAssess({ studentId: 1, questionId: 10, subjectId: 1, assessment: 'correct', source: 'exam', sourceRefId: 5 });
    expect(deps.judgeCore.recordSelfAssessment).toHaveBeenCalledWith({ studentId: 1, questionId: 10, subjectId: 1, assessment: 'correct', source: 'exam', sourceRefId: 5 });
    expect(deps.explanationCache.ensureExplanation).not.toHaveBeenCalled();
  });
});

describe('TrainingController.selfAssess 校验', () => {
  const mkController = (service: any) =>
    new TrainingController(service, {} as never, {} as never, {} as never);
  const user = { sub: 7, role: 'student' } as any;

  it('source 越界 -> 400', async () => {
    const svc: any = { selfAssess: vi.fn() };
    const c = mkController(svc);
    await expect(
      c.selfAssess({ questionId: 10, subjectId: 1, assessment: 'correct', source: 'practice' } as any, user),
    ).rejects.toMatchObject({ status: 400 });
    expect(svc.selfAssess).not.toHaveBeenCalled();
  });

  it('assessment 越界 -> 400', async () => {
    const svc: any = { selfAssess: vi.fn() };
    const c = mkController(svc);
    await expect(
      c.selfAssess({ questionId: 10, subjectId: 1, assessment: 'maybe' as any, source: 'targeted' }, user),
    ).rejects.toMatchObject({ status: 400 });
    expect(svc.selfAssess).not.toHaveBeenCalled();
  });

  it('questionId/subjectId 非正整数 -> 400', async () => {
    const svc: any = { selfAssess: vi.fn() };
    const c = mkController(svc);
    for (const payload of [
      { questionId: 0, subjectId: 1, assessment: 'correct', source: 'targeted' },
      { questionId: 10, subjectId: -1, assessment: 'correct', source: 'targeted' },
      { questionId: 1.5, subjectId: 1, assessment: 'correct', source: 'targeted' },
    ] as any[]) {
      await expect(c.selfAssess(payload, user)).rejects.toMatchObject({ status: 400 });
    }
    expect(svc.selfAssess).not.toHaveBeenCalled();
  });

  it('合法请求透传 service（sourceRefId 缺省转 null）', async () => {
    const svc: any = { selfAssess: vi.fn().mockResolvedValue({ errorBookId: 42 }) };
    const c = mkController(svc);
    await c.selfAssess({ questionId: 10, subjectId: 1, assessment: 'incorrect', source: 'exam', sourceRefId: 5 }, user);
    expect(svc.selfAssess).toHaveBeenCalledWith({ studentId: 7, questionId: 10, subjectId: 1, assessment: 'incorrect', source: 'exam', sourceRefId: 5 });
  });
});

describe('TrainingService.bumpErrorLevels', () => {
  it('透传 errorBookIds + studentId（归属校验）给 repo.bumpLevels', async () => {
    const deps = mk();
    const svc = mkSvc(deps);
    await svc.bumpErrorLevels([1, 2, 3], 7);
    expect(deps.mainErrorRepo.bumpLevels).toHaveBeenCalledWith([1, 2, 3], 7);
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

  it('透传抽题参数给 repo（studentId 首参 + type=null 不过滤题型）', async () => {
    const deps = mk();
    await mkSvc(deps).startTargetedPractice({ studentId: 7, subjectId: 1, kpId: 3, type: null, count: 5 });
    expect(deps.questionsRepo.findRandomByKpAndType).toHaveBeenCalledWith(7, 1, 3, null, 5);
  });

  it('透传非空 type', async () => {
    const deps = mk();
    await mkSvc(deps).startTargetedPractice({ studentId: 7, subjectId: 1, kpId: 3, type: 'proof', count: 10 });
    expect(deps.questionsRepo.findRandomByKpAndType).toHaveBeenCalledWith(7, 1, 3, 'proof', 10);
  });

  it('白名单序列化：只出 questionId/text/type/options，剥离 answer/explanation/material', async () => {
    const deps = mk({
      questionsRepo: { findRandomByKpAndType: vi.fn().mockResolvedValue([questionRow]) },
    });
    const r = await mkSvc(deps).startTargetedPractice({ studentId: 7, subjectId: 1, kpId: 3, type: 'choice', count: 5 });
    expect(r.questions).toHaveLength(1);
    const q = r.questions[0];
    expect(q).toEqual({ questionId: 10, text: '题面文本', type: 'choice', options: ['A. 1', 'B. 2'] });
    expect(Object.keys(q).sort()).toEqual(['options', 'questionId', 'text', 'type']);
    expect(JSON.stringify(r)).not.toContain('answer');
    expect(JSON.stringify(r)).not.toContain('explanation');
  });

  it('options 为 null 时原样返回 null，不抛错', async () => {
    const deps = mk({
      questionsRepo: { findRandomByKpAndType: vi.fn().mockResolvedValue([{ ...questionRow, options: null }]) },
    });
    const r = await mkSvc(deps).startTargetedPractice({ studentId: 7, subjectId: 1, kpId: 3, type: null, count: 5 });
    expect(r.questions[0].options).toBeNull();
  });

  it('抽不到题返回空数组（空集合非错误）且不建会话（0 题会话能 complete 拿走整档分）', async () => {
    const deps = mk({ questionsRepo: { findRandomByKpAndType: vi.fn().mockResolvedValue([]) } });
    const r = await mkSvc(deps).startTargetedPractice({ studentId: 7, subjectId: 1, kpId: 999, type: null, count: 5 });
    expect(r).toEqual({ questions: [], sessionId: null });
    expect(deps.trainingSessionsRepo.create).not.toHaveBeenCalled();
  });
});

describe('TrainingService.startTargetedPractice — 建会话（乙类整批发分）', () => {
  const questionRow = { id: 10, type: 'choice', content: '题面文本', options: null, is_active: 1 } as never;

  it('tier_key = 学生选的档位；expected_count = 后端实际抽到的题数（题池不够时两者不等）', async () => {
    // 选 10 题档，题池只有 7 题 —— 发分按档位（10）走规则，实际抽到 7 只作审计留痕。
    const rows = Array.from({ length: 7 }, (_, i) => ({ ...(questionRow as object), id: 100 + i }));
    const deps = mk({ questionsRepo: { findRandomByKpAndType: vi.fn().mockResolvedValue(rows) } });
    const r = await mkSvc(deps).startTargetedPractice({ studentId: 7, subjectId: 1, kpId: 3, type: null, count: 10 });
    expect(deps.trainingSessionsRepo.create).toHaveBeenCalledWith({
      student_id: 7,
      task_code: 'math_targeted',
      subject_id: 1,
      tier_key: '10',
      expected_count: 7,
      ref_type: 'question',
      ref_id: null,
    });
    expect(r.sessionId).toBe(101);
  });

  it('抽满时 expected_count == 抽到的题数 == 档位', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ ...(questionRow as object), id: 200 + i }));
    const deps = mk({ questionsRepo: { findRandomByKpAndType: vi.fn().mockResolvedValue(rows) } });
    await mkSvc(deps).startTargetedPractice({ studentId: 7, subjectId: 1, kpId: 3, type: null, count: 3 });
    expect(deps.trainingSessionsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ tier_key: '3', expected_count: 3 }),
    );
  });
});

describe('TrainingController.startTargetedPractice — 档位白名单（定案 7）', () => {
  const user = { sub: 7, role: 'student' } as any;
  /** 家长已配的档位（默认档位 1/3/5/10）。 */
  const TIERS = ['1', '3', '5', '10'];
  const mkController = (service: any, tiers: string[] = TIERS) =>
    new TrainingController(
      service,
      { create: vi.fn() } as never,
      {} as never,
      { listTierKeys: vi.fn().mockResolvedValue(tiers) } as never,
    );

  it('count 不在已配档位（13）→ 400，且 service / 会话创建都没被碰', async () => {
    const svc: any = { startTargetedPractice: vi.fn() };
    const c = mkController(svc);
    await expect(
      c.startTargetedPractice({ subjectId: 1, kpId: 3, type: null, count: 13 }, user),
    ).rejects.toMatchObject({ status: 400 });
    expect(svc.startTargetedPractice).not.toHaveBeenCalled();
  });

  it('白名单查询用的是 JWT 学生 id + math_targeted 任务码', async () => {
    const svc: any = { startTargetedPractice: vi.fn().mockResolvedValue({ questions: [], sessionId: 1 }) };
    const rules: any = { listTierKeys: vi.fn().mockResolvedValue(TIERS) };
    const c = new TrainingController(svc, { create: vi.fn() } as never, {} as never, rules);
    await c.startTargetedPractice({ subjectId: 1, kpId: 3, type: null, count: 3 }, user);
    expect(rules.listTierKeys).toHaveBeenCalledWith(7, 'math_targeted');
  });

  it('count 越界（0 / 21 / 非整数）-> 400', async () => {
    const svc: any = { startTargetedPractice: vi.fn() };
    const c = mkController(svc);
    for (const count of [0, 21, 1.5, NaN]) {
      await expect(
        c.startTargetedPractice({ subjectId: 1, kpId: 3, type: null, count }, user),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(svc.startTargetedPractice).not.toHaveBeenCalled();
  });

  it('type 非白名单值 -> 400', async () => {
    const svc: any = { startTargetedPractice: vi.fn() };
    const c = mkController(svc);
    await expect(
      c.startTargetedPractice({ subjectId: 1, kpId: 3, type: 'essay', count: 5 }, user),
    ).rejects.toMatchObject({ status: 400 });
    expect(svc.startTargetedPractice).not.toHaveBeenCalled();
  });

  it('合法 type（含 null）与已配档位透传 service（含 studentId），返回体带回 sessionId', async () => {
    const svc: any = {
      startTargetedPractice: vi.fn()
        .mockResolvedValueOnce({ questions: [], sessionId: 11 })
        .mockResolvedValueOnce({ questions: [], sessionId: 12 }),
    };
    const c = mkController(svc);
    const r1 = await c.startTargetedPractice({ subjectId: 1, kpId: 3, type: null, count: 1 }, user);
    const r2 = await c.startTargetedPractice({ subjectId: 1, kpId: 3, type: 'proof', count: 10 }, user);
    expect(r1).toEqual({ questions: [], sessionId: 11 });
    expect(r2).toEqual({ questions: [], sessionId: 12 });
    expect(svc.startTargetedPractice).toHaveBeenNthCalledWith(1, { studentId: 7, subjectId: 1, kpId: 3, type: null, count: 1 });
    expect(svc.startTargetedPractice).toHaveBeenNthCalledWith(2, { studentId: 7, subjectId: 1, kpId: 3, type: 'proof', count: 10 });
  });

  it('从未发过分的全新学生：先 ensureRules 补默认档位再查，count=3 放行（返回空数组会 400 掉所有请求）', async () => {
    const rules = freshPointRules();
    const svc: any = { startTargetedPractice: vi.fn().mockResolvedValue({ questions: [], sessionId: 42 }) };
    const c = new TrainingController(svc, { create: vi.fn() } as never, {} as never, rules.service as never);

    const r = await c.startTargetedPractice({ subjectId: 1, kpId: 3, type: null, count: 3 }, { sub: 9, role: 'student' } as any);

    expect(rules.rulesRepo.insertIgnoreBatch).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ questions: [], sessionId: 42 });
  });

  it('家长停用了某档（is_active=0，listTierKeys 不再返回它）→ 该 count 400', async () => {
    const svc: any = { startTargetedPractice: vi.fn() };
    const c = mkController(svc, ['1', '3', '10']); // '5' 被停用
    await expect(
      c.startTargetedPractice({ subjectId: 1, kpId: 3, type: null, count: 5 }, user),
    ).rejects.toMatchObject({ status: 400 });
    expect(svc.startTargetedPractice).not.toHaveBeenCalled();
  });
});

describe('TrainingController.completeSession — 完成会话整批发分', () => {
  const user = { sub: 7, role: 'student' } as any;
  const SESSION = {
    id: 55, student_id: 7, task_code: 'math_targeted', tier_key: '10',
    expected_count: 7, status: 'in_progress',
  } as never;

  const mkC = (over: { session?: any; affected?: number; award?: any; awardThrows?: Error } = {}) => {
    const sessionsRepo = {
      // `session: null` 是「查不到」用例，不能用 ?? 兜回默认会话
      findById: vi.fn().mockResolvedValue('session' in over ? over.session : SESSION),
      completeOwned: vi.fn().mockResolvedValue(over.affected ?? 1),
      incrementJudged: vi.fn().mockResolvedValue(undefined),
    };
    const points = {
      award: over.awardThrows
        ? vi.fn().mockRejectedValue(over.awardThrows)
        : vi.fn().mockResolvedValue(over.award ?? {
            pointsAwarded: 35, balance: 35, totalEarned: 35, levelUp: null,
          }),
    };
    const c = new TrainingController({} as never, sessionsRepo as never, points as never, {} as never);
    return { c, sessionsRepo, points };
  };

  it('首次完成：award 调一次、档位取自会话记录、dedupe=tsess:<id>、无 reason', async () => {
    const { c, sessionsRepo, points } = mkC();
    const res = await c.completeSession(55, user);
    expect(sessionsRepo.completeOwned).toHaveBeenCalledWith(55, 7);
    expect(points.award).toHaveBeenCalledTimes(1);
    expect(points.award).toHaveBeenCalledWith({
      studentId: 7,
      taskCode: 'math_targeted',
      tierKey: '10',
      dedupeKey: 'tsess:55',
      refType: 'training_session',
      refId: 55,
    });
    expect(res).toEqual({ pointsAwarded: 35, balance: 35, totalEarned: 35, levelUp: null });
    expect('reason' in res).toBe(false);
  });

  it('背单词会话的 dedupe 前缀是 vsess（按任务分，不能写死一个）', async () => {
    const { c, points } = mkC({
      session: { ...(SESSION as object), task_code: 'en_vocabulary', tier_key: '15' },
    });
    await c.completeSession(55, user);
    expect(points.award).toHaveBeenCalledWith(expect.objectContaining({
      taskCode: 'en_vocabulary', tierKey: '15', dedupeKey: 'vsess:55',
    }));
  });

  it('重复完成（affected=0、award 回 duplicate）→ 不报错、reason=already_completed、pointsAwarded 归 0（不是首次值）', async () => {
    const { c } = mkC({
      affected: 0,
      award: { pointsAwarded: 35, balance: 35, totalEarned: 35, levelUp: null, reason: 'duplicate' },
    });
    const res = await c.completeSession(55, user);
    expect((res as { reason?: string }).reason).toBe('already_completed');
    expect(res.pointsAwarded).toBe(0);
  });

  it('别人家学生的会话 → 404（1002），不置完成、不发分', async () => {
    const { c, sessionsRepo, points } = mkC({ session: { ...(SESSION as object), student_id: 8 } });
    await expect(c.completeSession(55, user)).rejects.toMatchObject({
      status: 404,
      response: { code: 1002 },
    });
    expect(sessionsRepo.completeOwned).not.toHaveBeenCalled();
    expect(points.award).not.toHaveBeenCalled();
  });

  it('会话不存在 → 404（1002）', async () => {
    const { c } = mkC({ session: null });
    await expect(c.completeSession(55, user)).rejects.toMatchObject({ status: 404 });
  });

  it('award 回 daily_limit（每日上限用完）→ 不报错、pointsAwarded=0、reason 透传', async () => {
    const { c } = mkC({
      award: { pointsAwarded: 0, balance: 35, totalEarned: 35, levelUp: null, reason: 'daily_limit' },
    });
    const res = await c.completeSession(55, user);
    expect(res).toEqual({
      pointsAwarded: 0, balance: 35, totalEarned: 35, levelUp: null, reason: 'daily_limit',
    });
  });

  it('levelUp 用段位 code 字符串（wire 形状，不是 LevelInfo 对象）', async () => {
    const { c } = mkC({
      award: {
        pointsAwarded: 35, balance: 535, totalEarned: 535, levelUp: null,
      },
    });
    const res = await c.completeSession(55, user);
    expect(res.levelUp).toBeNull();

    const { c: c2 } = mkC({
      award: {
        pointsAwarded: 35, balance: 535, totalEarned: 535,
        levelUp: { from: { code: 'pichai' }, to: { code: 'zhutie' } },
      },
    });
    expect((await c2.completeSession(55, user)).levelUp).toEqual({ from: 'pichai', to: 'zhutie' });
  });

  it('award 抛错（DB 故障）→ 请求不 500，按未入账降级返回', async () => {
    const { c } = mkC({ awardThrows: new Error('db down') });
    const res = await c.completeSession(55, user);
    expect(res).toEqual({ pointsAwarded: 0, balance: 0, totalEarned: 0, levelUp: null });
  });
});

describe('TrainingController.judge — 可选 sessionId 只做审计留痕', () => {
  const user = { sub: 7, role: 'student' } as any;
  const DTO = { questionId: 10, subjectId: 1, studentAnswer: 'A', source: 'targeted' } as const;

  const mkC = (over: { incrementJudged?: any; result?: any } = {}) => {
    const sessionsRepo = {
      incrementJudged: over.incrementJudged ?? vi.fn().mockResolvedValue(undefined),
    };
    const svc = { judgeTraining: vi.fn().mockResolvedValue(over.result ?? { isCorrect: true }) };
    const c = new TrainingController(svc as never, sessionsRepo as never, {} as never, {} as never);
    return { c, sessionsRepo, svc };
  };

  it('带 sessionId → incrementJudged(sessionId, 学生 id)，判题结果照常返回', async () => {
    const { c, sessionsRepo } = mkC();
    const res = await c.judge({ ...DTO, sessionId: 55 }, user);
    expect(sessionsRepo.incrementJudged).toHaveBeenCalledWith(55, 7);
    expect(res).toEqual({ isCorrect: true });
  });

  it('不传 sessionId → 不碰会话表', async () => {
    const { c, sessionsRepo } = mkC();
    await c.judge({ ...DTO }, user);
    expect(sessionsRepo.incrementJudged).not.toHaveBeenCalled();
  });

  it('sessionId 非法（0 / 负数 / 字符串 / 小数）→ 跳过审计，判题照常', async () => {
    const { c, sessionsRepo } = mkC();
    for (const sessionId of [0, -1, '55', 1.5, NaN]) {
      await expect(c.judge({ ...DTO, sessionId } as never, user)).resolves.toEqual({ isCorrect: true });
    }
    expect(sessionsRepo.incrementJudged).not.toHaveBeenCalled();
  });

  it('会话不存在 / 别人的 / 已完成（repo 不抛、0 行受影响）→ 判题照常', async () => {
    const { c } = mkC();
    await expect(c.judge({ ...DTO, sessionId: 999999 }, user)).resolves.toEqual({ isCorrect: true });
  });

  it('审计写库抛错 → 静默，判题照常返回（审计绝不能挡住判题）', async () => {
    const { c } = mkC({ incrementJudged: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(c.judge({ ...DTO, sessionId: 55 }, user)).resolves.toEqual({ isCorrect: true });
  });
});


describe('TrainingController 解析拉取端点', () => {
  const mkController = (service: any) =>
    new TrainingController(service, {} as never, {} as never, {} as never);

  it('getExplanations：ids 逗号分隔字符串 -> 数字数组（空/坏值过滤后由 service 再兜底）', async () => {
    const svc: any = { getExplanations: vi.fn().mockResolvedValue({ explanations: {} }) };
    const c = mkController(svc);
    await c.getExplanations('10,11,abc,');
    expect(svc.getExplanations).toHaveBeenCalledWith([10, 11]);
  });

  it('getExplanations：ids 缺省/空字符串 -> 空数组透传', async () => {
    const svc: any = { getExplanations: vi.fn().mockResolvedValue({ explanations: {} }) };
    const c = mkController(svc);
    await c.getExplanations('');
    expect(svc.getExplanations).toHaveBeenCalledWith([]);
  });

  it('waitForExplanation：透传 questionId 给 service', async () => {
    const svc: any = { waitForExplanation: vi.fn().mockResolvedValue({ explanation: null }) };
    const c = mkController(svc);
    await c.waitForExplanation(10);
    expect(svc.waitForExplanation).toHaveBeenCalledWith(10);
  });
});

describe('TrainingService.markHidden', () => {
  it('题目存在 -> repo.mark(studentId, subjectId, questionId)', async () => {
    const deps = mk({
      questionsRepo: { findById: vi.fn().mockResolvedValue({ id: 10, content: '题面', type: 'choice' }) },
    });
    await mkSvc(deps).markHidden(7, 1, 10);
    expect(deps.hiddenRepo.mark).toHaveBeenCalledWith(7, 1, 10);
  });
  it('题目不存在 -> 404，不调 repo.mark', async () => {
    const deps = mk({ questionsRepo: { findById: vi.fn().mockResolvedValue(null) } });
    await expect(mkSvc(deps).markHidden(7, 1, 999)).rejects.toMatchObject({ status: 404 });
    expect(deps.hiddenRepo.mark).not.toHaveBeenCalled();
  });
});

describe('TrainingService.unmarkHidden', () => {
  it('透传 (studentId, questionId) 给 repo.unmark', async () => {
    const deps = mk();
    await mkSvc(deps).unmarkHidden(7, 10);
    expect(deps.hiddenRepo.unmark).toHaveBeenCalledWith(7, 10);
  });
});

describe('TrainingService.unmarkAllHidden', () => {
  it('透传 studentId 给 repo.unmarkAll', async () => {
    const deps = mk();
    await mkSvc(deps).unmarkAllHidden(7);
    expect(deps.hiddenRepo.unmarkAll).toHaveBeenCalledWith(7);
  });
});

describe('TrainingService.listHidden', () => {
  it('透传 (studentId, subjectId) 给 repo.findAllByStudent', async () => {
    const rows = [{ questionId: 10, questionText: '题面', type: 'choice', kpName: '有理数', markedAt: new Date('2026-09-04') }];
    const deps = mk({ hiddenRepo: { findAllByStudent: vi.fn().mockResolvedValue(rows) } });
    const r = await mkSvc(deps).listHidden(7, 1);
    expect(deps.hiddenRepo.findAllByStudent).toHaveBeenCalledWith(7, 1);
    expect(r).toEqual(rows);
  });
});

describe('TrainingService.getExplanations', () => {
  it('过滤非正整数 id 后透传 explanationCache.waitForExplanations', async () => {
    const deps = mk({
      explanationCache: { waitForExplanations: vi.fn().mockResolvedValue({ 10: '题解' }), waitExplanation: vi.fn() },
    });
    const r = await mkSvc(deps).getExplanations([10, 0, -1, 11]);
    expect(deps.explanationCache.waitForExplanations).toHaveBeenCalledWith([10, 11]);
    expect(r).toEqual({ explanations: { 10: '题解' } });
  });
});

describe('TrainingService.waitForExplanation', () => {
  const activeQuestion = { id: 10, explanation: '' };

  it('题目不存在/停用 -> 不触发生成不写通知，返回 null', async () => {
    const deps = mk({ questionsRepo: { findById: vi.fn().mockResolvedValue(null), findRandomByKpAndType: vi.fn() } });
    const r = await mkSvc(deps).waitForExplanation(999);
    expect(r).toEqual({ explanation: null });
    expect(deps.explanationCache.waitExplanation).not.toHaveBeenCalled();
    expect(deps.notificationsRepo.create).not.toHaveBeenCalled();
  });

  it('解析成功 -> 返回 explanation，不写通知', async () => {
    const deps = mk({
      questionsRepo: { findById: vi.fn().mockResolvedValue(activeQuestion), findRandomByKpAndType: vi.fn() },
      explanationCache: { waitForExplanations: vi.fn(), waitExplanation: vi.fn().mockResolvedValue('题解') },
    });
    const r = await mkSvc(deps).waitForExplanation(10);
    expect(r).toEqual({ explanation: '题解' });
    expect(deps.notificationsRepo.create).not.toHaveBeenCalled();
  });

  it('超时 null -> 重读确认无解析后写 explanation_failed 通知（按 question_id+type 去重）', async () => {
    const deps = mk({
      questionsRepo: { findById: vi.fn().mockResolvedValue(activeQuestion), findRandomByKpAndType: vi.fn() },
    });
    const r = await mkSvc(deps).waitForExplanation(10);
    expect(r).toEqual({ explanation: null });
    expect(deps.explanationCache.waitExplanation).toHaveBeenCalledWith(10, 120_000);
    expect(deps.notificationsRepo.hasUnreadByQuestion).toHaveBeenCalledWith(10, 'explanation_failed');
    expect(deps.notificationsRepo.create).toHaveBeenCalledWith({
      type: 'explanation_failed',
      questionId: 10,
      title: '题解生成失败',
      content: expect.stringContaining('#10'),
    });
  });

  it('超时后重读发现解析已生成 -> 直接返回该解析，不写通知（防误报）', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn()
          .mockResolvedValueOnce(activeQuestion)                              // 存在性检查
          .mockResolvedValueOnce({ id: 10, explanation: '迟到题解' }),        // 超时后重读
        findRandomByKpAndType: vi.fn(),
      },
    });
    const r = await mkSvc(deps).waitForExplanation(10);
    expect(r).toEqual({ explanation: '迟到题解' });
    expect(deps.notificationsRepo.create).not.toHaveBeenCalled();
  });

  it('同题已有未读 -> 不再重复写', async () => {
    const deps = mk({
      questionsRepo: { findById: vi.fn().mockResolvedValue(activeQuestion), findRandomByKpAndType: vi.fn() },
      notificationsRepo: { hasUnreadByQuestion: vi.fn().mockResolvedValue(true), create: vi.fn() },
    });
    await mkSvc(deps).waitForExplanation(10);
    expect(deps.notificationsRepo.hasUnreadByQuestion).toHaveBeenCalledWith(10, 'explanation_failed');
    expect(deps.notificationsRepo.create).not.toHaveBeenCalled();
  });

  it('通知写入失败不阻断返回（best-effort）', async () => {
    const deps = mk({
      questionsRepo: { findById: vi.fn().mockResolvedValue(activeQuestion), findRandomByKpAndType: vi.fn() },
      notificationsRepo: { hasUnreadByQuestion: vi.fn().mockRejectedValue(new Error('db down')), create: vi.fn() },
    });
    const r = await mkSvc(deps).waitForExplanation(10);
    expect(r).toEqual({ explanation: null });
  });
});
