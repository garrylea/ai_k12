/**
 * RemediationGeneratorService（补偿套题生成器，Task 6）单元测试。
 *
 * 两条铁律被用例钉住：
 *
 * 1. `buildGroups` 只做同步工作（三元组成组 + 题库抽题 + 记缺口），LLM 补题一律
 *    fire-and-forget（spec §5.1：LLM 调用无墙钟上限，不得挂在关键路径上）。因此
 *    **断言后台任务必须用 `vi.waitFor` 确定性等待**，不能靠微任务运气。
 * 2. AI 生成题入 `questions` 前必须剥掉 `options[].isCorrect`（spec §5.3 关键铁律）——
 *    否则选项里藏答案，判题前就泄漏。
 */
import { describe, it, expect, vi } from 'vitest';
import { RemediationGeneratorService } from './remediation-generator.service.js';
import { computeContentHash } from '../../common/utils/content-hash.util.js';
import type { QuestionRow } from '../../database/repositories/types.js';
import type { RemediationGroupRow } from '../../database/repositories/remediation.repo.js';
import type { VariationQuestion } from '../../ai-core/types.js';

const STUDENT_ID = 7;
const SET_ID = 1;
const GROUP_ID = 100;
const KP_ID = 10;
const KP_NAME = '一元二次方程';

// QuestionRow extends RowDataPacket，其 `constructor` 是字面量类型，无法用 Partial<QuestionRow> 收窄；
// 测试夹具用宽松入参 + 断言出参即可。
function makeQuestion(over: Record<string, unknown> = {}): QuestionRow {
  return {
    id: 1,
    subject_id: 1,
    type: 'choice',
    difficulty: 1,
    content: '原错题题干',
    options: null,
    answer: 'A',
    explanation: null,
    source: null,
    content_hash: null,
    is_active: 1,
    created_at: new Date('2026-09-21T00:00:00Z'),
    ...over,
  } as unknown as QuestionRow;
}

function makeGroup(over: Partial<RemediationGroupRow> = {}): RemediationGroupRow {
  return {
    id: GROUP_ID,
    set_id: SET_ID,
    kp_id: KP_ID,
    type: 'choice',
    difficulty: 1,
    origin_question_id: 1,
    ai_pending_count: 2,
    created_at: new Date('2026-09-21T00:00:00Z'),
    ...over,
  } as RemediationGroupRow;
}

function makeVariation(over: Partial<VariationQuestion> = {}): VariationQuestion {
  return {
    content: 'AI 生成的相似题',
    options: [
      { label: 'A', text: '选项甲', isCorrect: true },
      { label: 'B', text: '选项乙', isCorrect: false },
    ],
    answer: 'A',
    explanation: '解析',
    difficulty: 1,
    variationType: '换数',
    ...over,
  };
}

/**
 * mock 必须与真实仓储同构：`insertItems` 返回 INSERT IGNORE 的 affectedRows
 * （不是恒 0），否则「缺口 = 3 - 实际入库题数」会被算错。
 */
function harness() {
  const questionsRepo = {
    findPrimaryKpIds: vi.fn().mockResolvedValue(new Map<number, number>()),
    // 默认「题库抽不到题」；需要抽到题的用例自行 mockResolvedValueOnce。
    findRandomByKpTypeDifficulty: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(makeQuestion()),
    findOrCreate: vi.fn().mockResolvedValue({ id: 900, created: true }),
    bindKnowledgePoint: vi.fn().mockResolvedValue(undefined),
  };
  const knowledgePointsRepo = {
    findById: vi.fn().mockResolvedValue({
      id: KP_ID,
      name: KP_NAME,
      subject_id: 1,
      parent_kp_id: null,
      grade_band: 'junior',
    }),
  };
  const remediationRepo = {
    findItemsBySet: vi.fn().mockResolvedValue([]),
    findGroupByTriple: vi.fn().mockResolvedValue(null),
    // fillWithAi -> runAiFill 的第一步就是读组；缺了它会 TypeError 被 catch 吞掉。
    findGroupById: vi.fn().mockResolvedValue(makeGroup()),
    findGroupsBySet: vi.fn().mockResolvedValue([]),
    createGroup: vi.fn().mockResolvedValue(GROUP_ID),
    insertItems: vi
      .fn()
      .mockImplementation(async (_groupId: number, ids: number[]) => ids.length),
    updateGroupAiPending: vi.fn().mockResolvedValue(undefined),
  };
  const variation = {
    generate: vi.fn().mockResolvedValue({ variations: [], generatedBy: 'mock-model' }),
  };

  const service = new RemediationGeneratorService(
    questionsRepo as any,
    knowledgePointsRepo as any,
    remediationRepo as any,
    variation as any,
  );
  return { service, questionsRepo, knowledgePointsRepo, remediationRepo, variation };
}

describe('RemediationGeneratorService.buildGroups', () => {
  it('同三元组合并：两道错题同(考点/题型/难度)只建一组', async () => {
    const { service, questionsRepo, remediationRepo } = harness();
    questionsRepo.findPrimaryKpIds.mockResolvedValue(new Map([[1, KP_ID], [2, KP_ID]]));
    questionsRepo.findRandomByKpTypeDifficulty.mockResolvedValue([
      { id: 101 }, { id: 102 }, { id: 103 },
    ] as any);

    const res = await service.buildGroups(STUDENT_ID, SET_ID, [
      makeQuestion({ id: 1 }),
      makeQuestion({ id: 2 }),
    ]);

    expect(remediationRepo.createGroup).toHaveBeenCalledTimes(1);
    expect(res.groupsCreated).toBe(1);
    expect(res.itemsCreated).toBe(3);
    expect(res.aiPendingCount).toBe(0);
  });

  it('题库抽到 1 题则缺口 2 并触发 AI 补题（fire-and-forget）', async () => {
    const { service, questionsRepo, remediationRepo, variation } = harness();
    questionsRepo.findPrimaryKpIds.mockResolvedValue(new Map([[1, KP_ID]]));
    questionsRepo.findRandomByKpTypeDifficulty
      .mockResolvedValueOnce([{ id: 101 }] as any) // 同档只有 1 题
      .mockResolvedValueOnce([] as any); // ±1 档也没有

    const res = await service.buildGroups(STUDENT_ID, SET_ID, [makeQuestion({ id: 1 })]);

    expect(res.aiPendingCount).toBe(2);
    expect(remediationRepo.updateGroupAiPending).toHaveBeenCalledWith(GROUP_ID, 2);
    // fillWithAi 有意不 await —— 确定性等待后台任务
    await vi.waitFor(() => expect(variation.generate).toHaveBeenCalledTimes(1));
    expect(variation.generate.mock.calls[0][0]).toMatchObject({
      count: 2,
      targetDifficulty: 1,
      knowledgePoint: { id: String(KP_ID), name: KP_NAME },
      originalQuestion: { content: '原错题题干', answer: 'A' },
    });
  });

  it('抽满 3 题则无缺口：不写 ai_pending、不触发 AI', async () => {
    const { service, questionsRepo, remediationRepo, variation } = harness();
    questionsRepo.findPrimaryKpIds.mockResolvedValue(new Map([[1, KP_ID]]));
    questionsRepo.findRandomByKpTypeDifficulty.mockResolvedValue([
      { id: 101 }, { id: 102 }, { id: 103 },
    ] as any);

    const res = await service.buildGroups(STUDENT_ID, SET_ID, [makeQuestion({ id: 1 })]);

    expect(res.itemsCreated).toBe(3);
    expect(remediationRepo.updateGroupAiPending).not.toHaveBeenCalled();
    expect(variation.generate).not.toHaveBeenCalled();
  });

  it('无 primary 考点标注的错题跳过并计数', async () => {
    const { service, questionsRepo, remediationRepo } = harness();
    questionsRepo.findPrimaryKpIds.mockResolvedValue(new Map());

    const res = await service.buildGroups(STUDENT_ID, SET_ID, [
      makeQuestion({ id: 1 }),
      makeQuestion({ id: 2 }),
    ]);

    expect(res.skippedNoKp).toBe(2);
    expect(res.groupsCreated).toBe(0);
    expect(remediationRepo.createGroup).not.toHaveBeenCalled();
  });

  it('该三元组已有组则跳过：不重复建组、不重复抽题（追加合并去重）', async () => {
    const { service, questionsRepo, remediationRepo } = harness();
    questionsRepo.findPrimaryKpIds.mockResolvedValue(new Map([[1, KP_ID]]));
    remediationRepo.findGroupByTriple.mockResolvedValue(makeGroup());

    const res = await service.buildGroups(STUDENT_ID, SET_ID, [makeQuestion({ id: 1 })]);

    expect(res.groupsCreated).toBe(0);
    expect(remediationRepo.createGroup).not.toHaveBeenCalled();
    expect(questionsRepo.findRandomByKpTypeDifficulty).not.toHaveBeenCalled();
  });

  it('放宽阶梯：同档不足时按 ±1 档再抽一轮，且排除原错题与套题已有题', async () => {
    const { service, questionsRepo, remediationRepo } = harness();
    questionsRepo.findPrimaryKpIds.mockResolvedValue(new Map([[1, KP_ID]]));
    remediationRepo.findItemsBySet.mockResolvedValue([{ question_id: 55 }] as any);
    questionsRepo.findRandomByKpTypeDifficulty
      .mockResolvedValueOnce([{ id: 101 }, { id: 102 }] as any)
      .mockResolvedValueOnce([{ id: 201 }] as any);

    const res = await service.buildGroups(STUDENT_ID, SET_ID, [
      makeQuestion({ id: 1, difficulty: 2 }),
    ]);

    expect(questionsRepo.findRandomByKpTypeDifficulty).toHaveBeenCalledTimes(2);
    const first = questionsRepo.findRandomByKpTypeDifficulty.mock.calls[0];
    const second = questionsRepo.findRandomByKpTypeDifficulty.mock.calls[1];
    expect(first[4]).toEqual([2]); // 第一轮：同档
    expect(first[5]).toBe(3); // 还差 3 题
    expect(first[6]).toEqual([55, 1]); // 排除：套题已有 55 + 原错题 1
    expect(second[4]).toEqual([1, 3]); // 第二轮：±1 档
    expect(second[5]).toBe(1); // 只差 1 题
    expect(second[6]).toEqual([55, 1, 101, 102]); // 累积排除已抽到的题
    expect(res.itemsCreated).toBe(3);
    expect(res.aiPendingCount).toBe(0);
    expect(remediationRepo.updateGroupAiPending).not.toHaveBeenCalled();
  });
});

describe('RemediationGeneratorService.fillWithAi', () => {
  it('AI 题入库剥掉 isCorrect，options 只存 label/text（防答案泄漏）', async () => {
    const { service, questionsRepo, remediationRepo, variation } = harness();
    variation.generate.mockResolvedValue({
      variations: [makeVariation()],
      generatedBy: 'mock-model',
    });

    service.fillWithAi(GROUP_ID, []);
    await vi.waitFor(() => expect(questionsRepo.findOrCreate).toHaveBeenCalledTimes(1));

    const row = questionsRepo.findOrCreate.mock.calls[0][0] as any;
    expect(row.source).toBe('remediation');
    expect(row.subject_id).toBe(1);
    expect(row.type).toBe('choice');
    expect(row.difficulty).toBe(1);
    expect(row.content_hash).toBe(computeContentHash('AI 生成的相似题'));
    expect(JSON.parse(row.options)).toEqual([
      { label: 'A', text: '选项甲' },
      { label: 'B', text: '选项乙' },
    ]);
    expect(row.options).not.toContain('isCorrect');

    expect(remediationRepo.insertItems).toHaveBeenCalledWith(GROUP_ID, [900]);
    expect(questionsRepo.bindKnowledgePoint).toHaveBeenCalledWith(900, KP_ID, 'primary');
    await vi.waitFor(() =>
      expect(remediationRepo.updateGroupAiPending).toHaveBeenCalledWith(GROUP_ID, 0),
    );
  });

  it('撞 content_hash 复用已有题，且已在套题内则不重复入套', async () => {
    const { service, questionsRepo, remediationRepo, variation } = harness();
    variation.generate.mockResolvedValue({
      variations: [makeVariation()],
      generatedBy: 'mock-model',
    });
    remediationRepo.findItemsBySet.mockResolvedValue([{ question_id: 900 }] as any);
    questionsRepo.findOrCreate.mockResolvedValue({ id: 900, created: false });

    service.fillWithAi(GROUP_ID, []);
    await vi.waitFor(() =>
      expect(remediationRepo.updateGroupAiPending).toHaveBeenCalledWith(GROUP_ID, 0),
    );

    expect(remediationRepo.insertItems).not.toHaveBeenCalled();
    expect(questionsRepo.bindKnowledgePoint).not.toHaveBeenCalled();
  });

  it('校验不过的 AI 题不入库不入套，缺口清零并留日志', async () => {
    const { service, questionsRepo, remediationRepo, variation } = harness();
    variation.generate.mockResolvedValue({
      variations: [
        makeVariation({ content: '   ' }), // 题干为空
        makeVariation({ answer: '  ' }), // 无可解答案
        makeVariation({ options: [{ label: 'A', text: '唯一选项', isCorrect: true }] }), // choice 选项 < 2
      ],
      generatedBy: 'mock-model',
    });

    service.fillWithAi(GROUP_ID, []);
    await vi.waitFor(() =>
      expect(remediationRepo.updateGroupAiPending).toHaveBeenCalledWith(GROUP_ID, 0),
    );

    expect(questionsRepo.findOrCreate).not.toHaveBeenCalled();
    expect(remediationRepo.insertItems).not.toHaveBeenCalled();
  });

  it('原题或考点已下线：不调 LLM，直接清缺口', async () => {
    const { service, questionsRepo, remediationRepo, variation } = harness();
    questionsRepo.findById.mockResolvedValue(null);

    service.fillWithAi(GROUP_ID, []);
    await vi.waitFor(() =>
      expect(remediationRepo.updateGroupAiPending).toHaveBeenCalledWith(GROUP_ID, 0),
    );

    expect(variation.generate).not.toHaveBeenCalled();
  });

  it('组无缺口时不调 LLM', async () => {
    const { service, remediationRepo, variation } = harness();
    remediationRepo.findGroupById.mockResolvedValue(makeGroup({ ai_pending_count: 0 }));

    service.fillWithAi(GROUP_ID, []);
    await new Promise((r) => setTimeout(r, 0));

    expect(variation.generate).not.toHaveBeenCalled();
  });

  it('同组并发补题只跑一次（进程内 in-flight 去重）', async () => {
    const { service, remediationRepo, variation } = harness();
    let release!: (v: unknown) => void;
    variation.generate.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    service.fillWithAi(GROUP_ID, []);
    service.fillWithAi(GROUP_ID, []);
    await vi.waitFor(() => expect(variation.generate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(variation.generate).toHaveBeenCalledTimes(1);

    release({ variations: [], generatedBy: 'mock-model' });
    await vi.waitFor(() =>
      expect(remediationRepo.updateGroupAiPending).toHaveBeenCalledWith(GROUP_ID, 0),
    );
  });
});

describe('RemediationGeneratorService.retryPending', () => {
  it('只对 ai_pending > 0 的悬挂组补题（进程重启惰性重试）', async () => {
    const { service, remediationRepo, variation } = harness();
    remediationRepo.findGroupsBySet.mockResolvedValue([
      makeGroup({ id: 100, ai_pending_count: 2 }),
      makeGroup({ id: 200, ai_pending_count: 0 }),
    ]);
    remediationRepo.findGroupById.mockImplementation(async (id: number) =>
      id === 100
        ? makeGroup({ id: 100, ai_pending_count: 2 })
        : makeGroup({ id: 200, ai_pending_count: 0 }),
    );

    service.retryPending(SET_ID);
    await vi.waitFor(() => expect(variation.generate).toHaveBeenCalledTimes(1));

    expect(variation.generate.mock.calls[0][0]).toMatchObject({ count: 2 });
    await vi.waitFor(() =>
      expect(remediationRepo.updateGroupAiPending).toHaveBeenCalledWith(100, 0),
    );
    expect(remediationRepo.updateGroupAiPending).not.toHaveBeenCalledWith(200, 0);
  });
});
