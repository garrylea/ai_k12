import { describe, it, expect, vi } from 'vitest';
import { KnowledgeGraphService, MIN_SAMPLE_SIZE } from './knowledge-graph.service.js';

/**
 * 造一个只关心「树 × 掌握度 overlay」组装逻辑的 service：
 * 三个仓储全 mock，断言 confidence 三态、null ≠ 0、覆盖口径。
 */
function mk(overrides: Record<string, any> = {}) {
  const kpRepo = {
    findBySubject: vi.fn().mockResolvedValue([
      { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
      { id: 11, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
      { id: 12, name: '整式', parentKpId: 1, gradeBand: 'junior' },
    ]),
    countAvailableQuestionsByKp: vi.fn().mockResolvedValue(new Map([[11, 7], [12, 0]])),
    ...overrides.kpRepo,
  };
  const masteryRepo = {
    listBySubject: vi.fn().mockResolvedValue([]),
    countQuestionCoverageBySubject: vi.fn().mockResolvedValue({ coveredQuestions: 205, totalQuestions: 457 }),
    ...overrides.masteryRepo,
  };
  const errorsRepo = {
    countUncoveredUncleared: vi.fn().mockResolvedValue(4),
    ...overrides.errorsRepo,
  };
  const svc = new KnowledgeGraphService(kpRepo as any, masteryRepo as any, errorsRepo as any);
  return { svc, kpRepo, masteryRepo, errorsRepo };
}

const seen = new Date('2026-09-20T10:00:00.000Z');

describe('KnowledgeGraphService.getMastery', () => {
  it('未作答的 KP：masteryScore/level/计数全为 null（不是 0），confidence = none', async () => {
    const { svc } = mk();

    const result = await svc.getMastery(9, 1);

    const node11 = result.nodes.find((n) => n.id === 11)!;
    expect(node11.masteryScore).toBeNull();
    expect(node11.level).toBeNull();
    expect(node11.correctCount).toBeNull();
    expect(node11.errorCount).toBeNull();
    expect(node11.lastSeenAt).toBeNull();
    expect(node11.sampleSize).toBe(0);
    expect(node11.confidence).toBe('none');
  });

  it('样本 < 5 → insufficient（即使有行有分数）', async () => {
    const { svc } = mk({
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 11, masteryScore: 0, level: 0, correctCount: 0, errorCount: 1, lastSeenAt: seen },
        ]),
      },
    });

    const node11 = (await svc.getMastery(9, 1)).nodes.find((n) => n.id === 11)!;

    expect(node11.sampleSize).toBe(1);
    expect(node11.confidence).toBe('insufficient');
    // 分数照给（详情栏要显示「对 0 错 1」），只是不下强弱结论
    expect(node11.masteryScore).toBe(0);
  });

  it('样本正好 = 5 → ok（含边界）', async () => {
    const { svc } = mk({
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 11, masteryScore: 0.6, level: 3, correctCount: 3, errorCount: 2, lastSeenAt: seen },
        ]),
      },
    });

    const node11 = (await svc.getMastery(9, 1)).nodes.find((n) => n.id === 11)!;

    expect(node11.sampleSize).toBe(MIN_SAMPLE_SIZE);
    expect(node11.confidence).toBe('ok');
  });

  it('样本 = 4 → insufficient（不含边界）', async () => {
    const { svc } = mk({
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 11, masteryScore: 0.5, level: 2, correctCount: 2, errorCount: 2, lastSeenAt: seen },
        ]),
      },
    });

    expect((await svc.getMastery(9, 1)).nodes.find((n) => n.id === 11)!.confidence).toBe('insufficient');
  });

  it('lastSeenAt 序列化为 ISO 字符串；availableQuestionCount 缺省补 0', async () => {
    const { svc } = mk({
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 11, masteryScore: 0.6, level: 3, correctCount: 3, errorCount: 2, lastSeenAt: seen },
        ]),
      },
    });

    const nodes = (await svc.getMastery(9, 1)).nodes;

    expect(nodes.find((n) => n.id === 11)!.lastSeenAt).toBe('2026-09-20T10:00:00.000Z');
    expect(nodes.find((n) => n.id === 12)!.availableQuestionCount).toBe(0);
    expect(nodes.find((n) => n.id === 11)!.availableQuestionCount).toBe(7);
  });

  it('一级节点 parentId 为 null，二级指向一级；nodes 覆盖全树', async () => {
    const { svc } = mk();

    const nodes = (await svc.getMastery(9, 1)).nodes;

    expect(nodes).toHaveLength(3);
    expect(nodes.find((n) => n.id === 1)!.parentId).toBeNull();
    expect(nodes.find((n) => n.id === 11)!.parentId).toBe(1);
  });

  it('coverage 三字段都来自各自查询（学科口径）', async () => {
    const { svc, errorsRepo, masteryRepo } = mk();

    const result = await svc.getMastery(9, 1);

    expect(result.subjectId).toBe(1);
    expect(result.coverage).toEqual({
      coveredQuestions: 205,
      totalQuestions: 457,
      uncoveredUnclearedErrors: 4,
    });
    expect(masteryRepo.countQuestionCoverageBySubject).toHaveBeenCalledWith(1);
    expect(errorsRepo.countUncoveredUncleared).toHaveBeenCalledWith(9, 1);
  });
});

describe('KnowledgeGraphService.getWeakPoints', () => {
  /** 三个够格候选 + 一个样本不足 + 一个无题可抽，用于验闸门与排序。 */
  const rows = [
    { knowledgePointId: 11, masteryScore: 0.5, level: 2, correctCount: 5, errorCount: 5, lastSeenAt: seen },
    { knowledgePointId: 12, masteryScore: 0.5, level: 2, correctCount: 3, errorCount: 3, lastSeenAt: seen },
    { knowledgePointId: 13, masteryScore: 0.2, level: 1, correctCount: 1, errorCount: 4, lastSeenAt: seen },
    { knowledgePointId: 14, masteryScore: 0, level: 0, correctCount: 0, errorCount: 2, lastSeenAt: seen },
  ];
  const available = new Map([[11, 7], [12, 3], [13, 0]]);

  it('三道闸门：样本不足（14）与无题可抽（13）都被排除', async () => {
    const { svc } = mk({
      kpRepo: {
        findBySubject: vi.fn().mockResolvedValue([
          { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
          { id: 11, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
          { id: 12, name: '整式', parentKpId: 1, gradeBand: 'junior' },
          { id: 13, name: '分式', parentKpId: 1, gradeBand: 'junior' },
          { id: 14, name: '根式', parentKpId: 1, gradeBand: 'junior' },
        ]),
        countAvailableQuestionsByKp: vi.fn().mockResolvedValue(available),
      },
      masteryRepo: { listBySubject: vi.fn().mockResolvedValue(rows) },
    });

    const result = await svc.getWeakPoints(9, 1, 10);

    expect(result.candidates.map((c) => c.knowledgePointId)).toEqual([11, 12]);
    expect(result.reason).toBe('ok');
  });

  it('排序：mastery_score 升序 → error_count 降序 → kp_id 升序', async () => {
    const { svc } = mk({
      kpRepo: {
        findBySubject: vi.fn().mockResolvedValue([
          { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
          { id: 11, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
          { id: 12, name: '整式', parentKpId: 1, gradeBand: 'junior' },
          { id: 21, name: '方程', parentKpId: 1, gradeBand: 'junior' },
        ]),
        countAvailableQuestionsByKp: vi.fn().mockResolvedValue(new Map([[11, 5], [12, 5], [21, 5]])),
      },
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          // 同分（0.5），error_count 大者在前
          { knowledgePointId: 11, masteryScore: 0.5, level: 2, correctCount: 5, errorCount: 5, lastSeenAt: seen },
          { knowledgePointId: 21, masteryScore: 0.5, level: 2, correctCount: 3, errorCount: 3, lastSeenAt: seen },
          // 分最低，排第一
          { knowledgePointId: 12, masteryScore: 0.2, level: 1, correctCount: 1, errorCount: 4, lastSeenAt: seen },
        ]),
      },
    });

    const result = await svc.getWeakPoints(9, 1, 10);

    expect(result.candidates.map((c) => c.knowledgePointId)).toEqual([12, 11, 21]);
  });

  it('同分同错数时按 kp_id 升序（结果不抖动）', async () => {
    const { svc } = mk({
      kpRepo: {
        findBySubject: vi.fn().mockResolvedValue([
          { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
          { id: 31, name: 'A', parentKpId: 1, gradeBand: 'junior' },
          { id: 22, name: 'B', parentKpId: 1, gradeBand: 'junior' },
        ]),
        countAvailableQuestionsByKp: vi.fn().mockResolvedValue(new Map([[31, 5], [22, 5]])),
      },
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 31, masteryScore: 0.5, level: 2, correctCount: 5, errorCount: 5, lastSeenAt: seen },
          { knowledgePointId: 22, masteryScore: 0.5, level: 2, correctCount: 5, errorCount: 5, lastSeenAt: seen },
        ]),
      },
    });

    expect((await svc.getWeakPoints(9, 1, 10)).candidates.map((c) => c.knowledgePointId)).toEqual([22, 31]);
  });

  it('limit 生效：默认 1 时只回 1 个候选，recommendation = candidates[0]', async () => {
    const { svc } = mk({
      kpRepo: {
        findBySubject: vi.fn().mockResolvedValue([
          { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
          { id: 11, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
          { id: 12, name: '整式', parentKpId: 1, gradeBand: 'junior' },
        ]),
        countAvailableQuestionsByKp: vi.fn().mockResolvedValue(new Map([[11, 7], [12, 3]])),
      },
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 11, masteryScore: 0.5, level: 2, correctCount: 5, errorCount: 5, lastSeenAt: seen },
          { knowledgePointId: 12, masteryScore: 0.2, level: 1, correctCount: 1, errorCount: 4, lastSeenAt: seen },
        ]),
      },
    });

    const result = await svc.getWeakPoints(9, 1, 1);

    expect(result.candidates).toHaveLength(1);
    expect(result.recommendation!.knowledgePointId).toBe(12);
  });

  it('无够格候选 → 200 + recommendation null + reason no_qualified_candidate（不是错误）', async () => {
    const { svc } = mk();

    const result = await svc.getWeakPoints(9, 1, 1);

    expect(result.candidates).toEqual([]);
    expect(result.recommendation).toBeNull();
    expect(result.reason).toBe('no_qualified_candidate');
  });

  it('候选带 name（由 KP 树补全）与 availableQuestionCount', async () => {
    const { svc } = mk({
      kpRepo: {
        findBySubject: vi.fn().mockResolvedValue([
          { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
          { id: 11, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
        ]),
        countAvailableQuestionsByKp: vi.fn().mockResolvedValue(new Map([[11, 7]])),
      },
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 11, masteryScore: 0.4, level: 2, correctCount: 4, errorCount: 6, lastSeenAt: seen },
        ]),
      },
    });

    const c = (await svc.getWeakPoints(9, 1, 1)).candidates[0];

    expect(c).toEqual({
      knowledgePointId: 11,
      name: '有理数',
      parentId: 1,
      masteryScore: 0.4,
      level: 2,
      correctCount: 4,
      errorCount: 6,
      sampleSize: 10,
      availableQuestionCount: 7,
      lastSeenAt: '2026-09-20T10:00:00.000Z',
    });
  });
});
