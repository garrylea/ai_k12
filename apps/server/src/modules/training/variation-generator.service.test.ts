/**
 * VariationGeneratorService（错题升级变式生成器，PRD §7.10，2026-10-11）单元测试。
 *
 * 关键行为钉子：
 * 1. fire-and-forget：`generateForErrorItem` 返回 promise、调用点写 `void`（bump 链路钉子
 *    在 training.service 测试里）；LLM 永不 resolve 时本方法也必须立即返回。
 * 2. 各种跳过条件（不存在/非本人/已清零/孤儿/下线/空答案/true_false/无 KP/pending 已存在）
 *    都必须**不调 LLM、不留行**。
 * 3. 入库口径与补偿套题一致：剥 options[].isCorrect、choice answer 归一 label、
 *    source='variation'、created 才挂 primary KP、variation_questions 记 validator_passed=1。
 * 4. 轻校验拒绝 / AI 吐回原题（同 content_hash）不入库。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { VariationGeneratorService } from './variation-generator.service.js';
import { computeContentHash } from '../../common/utils/content-hash.util.js';
import type { QuestionRow } from '../../database/repositories/types.js';
import type { VariationQuestion } from '../../ai-core/types.js';

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  vi.restoreAllMocks();
});

const STUDENT_ID = 7;
const ERROR_ITEM_ID = 33;
const KP_ID = 10;
const KP_NAME = '一元二次方程';

function makeQuestion(over: Record<string, unknown> = {}): QuestionRow {
  return {
    id: 88,
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
    created_at: new Date('2026-10-11T00:00:00Z'),
    ...over,
  } as unknown as QuestionRow;
}

function makeVariation(over: Partial<VariationQuestion> = {}): VariationQuestion {
  return {
    content: 'AI 生成的变式题',
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

function harness(over: {
  meb?: Record<string, unknown> | null;
  question?: QuestionRow | null;
  pending?: boolean;
  kpId?: number | null;
  kp?: { id: number; name: string } | null;
} = {}) {
  const mainErrorRepo = {
    findById: vi.fn().mockResolvedValue(
      over.meb === undefined
        ? { id: ERROR_ITEM_ID, student_id: STUDENT_ID, subject_id: 1, question_id: 88, level: 2, is_cleared: 0, source: 'error_practice' }
        : over.meb,
    ),
  };
  const questionsRepo = {
    findById: vi.fn().mockResolvedValue(over.question === undefined ? makeQuestion() : over.question),
    findPrimaryKpIds: vi.fn().mockResolvedValue(new Map([[88, over.kpId === undefined ? KP_ID : over.kpId]])),
    findOrCreate: vi.fn().mockResolvedValue({ id: 900, created: true }),
    bindKnowledgePoint: vi.fn().mockResolvedValue(undefined),
  };
  const knowledgePointsRepo = {
    findById: vi.fn().mockResolvedValue(over.kp === undefined ? { id: KP_ID, name: KP_NAME } : over.kp),
  };
  const variationRepo = {
    hasPendingByErrorItem: vi.fn().mockResolvedValue(over.pending ?? false),
    insert: vi.fn().mockResolvedValue(501),
  };
  const variation = {
    generate: vi.fn().mockResolvedValue({
      variations: [makeVariation(), makeVariation({ content: 'AI 生成的变式题·第二道' })],
      generatedBy: 'test',
    }),
  };
  const service = new VariationGeneratorService(
    mainErrorRepo as any,
    questionsRepo as any,
    knowledgePointsRepo as any,
    variationRepo as any,
    variation as any,
  );
  return { service, mainErrorRepo, questionsRepo, knowledgePointsRepo, variationRepo, variation };
}

/** 等到微任务链排空（生成器内部全程 mock 同步 resolve，一轮 await 稳定足够）。 */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('VariationGeneratorService 跳过条件（不调 LLM、不留行）', () => {
  const skipCases: Array<[string, Parameters<typeof harness>[0]]> = [
    ['条目不存在', { meb: null }],
    ['非本人条目（IDOR）', { meb: { id: ERROR_ITEM_ID, student_id: 999, question_id: 88, is_cleared: 0 } }],
    ['条目已清零', { meb: { id: ERROR_ITEM_ID, student_id: STUDENT_ID, question_id: 88, is_cleared: 1 } }],
    ['孤儿条目（question_id NULL）', { meb: { id: ERROR_ITEM_ID, student_id: STUDENT_ID, question_id: null, is_cleared: 0 } }],
    ['pending 变式已存在', { pending: true }],
    ['原题已下线', { question: null }],
    ['原题无标准答案', { question: makeQuestion({ answer: null }) }],
    ['原题是 true_false', { question: makeQuestion({ type: 'true_false' }) }],
    ['无 primary 考点', { kpId: null }],
    ['考点不存在', { kp: null }],
  ];
  for (const [name, cfg] of skipCases) {
    it(`跳过：${name}`, async () => {
      const h = harness(cfg);
      void h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID);
      await settle();
      expect(h.variation.generate).not.toHaveBeenCalled();
      expect(h.variationRepo.insert).not.toHaveBeenCalled();
      expect(h.questionsRepo.findOrCreate).not.toHaveBeenCalled();
    });
  }
});

describe('VariationGeneratorService 正常生成', () => {
  it('调 LLM：count=2、targetDifficulty=原题难度、原题题面与答案透传', async () => {
    const h = harness({ question: makeQuestion({ difficulty: 2 }) });
    void h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID);
    await settle();
    expect(h.variation.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        originalQuestion: { content: '原错题题干', answer: 'A', difficulty: 2 },
        knowledgePoint: { id: String(KP_ID), name: KP_NAME },
        count: 2,
        targetDifficulty: 2,
      }),
    );
  });

  it('入库口径：剥 isCorrect、choice answer 归一 label、source=variation、content_hash；insert 记 main/validator_passed=1', async () => {
    const h = harness();
    void h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID);
    await settle();
    expect(h.questionsRepo.findOrCreate).toHaveBeenCalledTimes(2);
    const [row] = h.questionsRepo.findOrCreate.mock.calls[0];
    expect(row).toMatchObject({
      subject_id: 1,
      type: 'choice',
      difficulty: 1,
      source: 'variation',
      answer: 'A', // 正确选项 label（AI answer 就是 'A'）
    });
    expect(row.options).not.toContain('isCorrect');
    expect(JSON.parse(row.options)).toEqual([
      { label: 'A', text: '选项甲' },
      { label: 'B', text: '选项乙' },
    ]);
    expect(h.variationRepo.insert).toHaveBeenCalledTimes(2);
    expect(h.variationRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        original_error_item_id: ERROR_ITEM_ID,
        error_book_type: 'main',
        student_id: STUDENT_ID,
        validator_passed: 1,
      }),
    );
  });

  it('choice AI answer 写成选项文本时归一为正确选项 label（防恒判错回归钉子）', async () => {
    const h = harness();
    h.variation.generate.mockResolvedValue({
      variations: [
        makeVariation({ answer: '选项甲' }), // AI 把 answer 写成 text
      ],
      generatedBy: 'test',
    });
    void h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID);
    await settle();
    const [row] = h.questionsRepo.findOrCreate.mock.calls[0];
    expect(row.answer).toBe('A');
  });

  it('新题（created=true）才挂 primary KP；撞 hash 复用旧题不挂', async () => {
    const h = harness();
    h.questionsRepo.findOrCreate
      .mockResolvedValueOnce({ id: 900, created: true })
      .mockResolvedValueOnce({ id: 901, created: false });
    void h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID);
    await settle();
    expect(h.questionsRepo.bindKnowledgePoint).toHaveBeenCalledTimes(1);
    expect(h.questionsRepo.bindKnowledgePoint).toHaveBeenCalledWith(900, KP_ID, 'primary');
  });

  it('choice 校验拒绝（两个 isCorrect）不入库；另一道通过的照常入库', async () => {
    const h = harness();
    h.variation.generate.mockResolvedValue({
      variations: [
        makeVariation({ options: [
          { label: 'A', text: '甲', isCorrect: true },
          { label: 'B', text: '乙', isCorrect: true },
        ] }),
        makeVariation({ content: '正常的第二道' }),
      ],
      generatedBy: 'test',
    });
    void h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID);
    await settle();
    expect(h.questionsRepo.findOrCreate).toHaveBeenCalledTimes(1);
    expect(h.variationRepo.insert).toHaveBeenCalledTimes(1);
  });

  it('AI 吐回原题（同 content_hash）视为无效不入库', async () => {
    const original = makeQuestion({ content_hash: computeContentHash('原错题题干') });
    const h = harness({ question: original });
    h.variation.generate.mockResolvedValue({
      variations: [makeVariation({ content: '原错题题干' })],
      generatedBy: 'test',
    });
    void h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID);
    await settle();
    expect(h.questionsRepo.findOrCreate).not.toHaveBeenCalled();
    expect(h.variationRepo.insert).not.toHaveBeenCalled();
  });

  it('全部被拒（0 道通过）不补偿，insert 0 行', async () => {
    const h = harness();
    h.variation.generate.mockResolvedValue({
      variations: [makeVariation({ content: '  ' })],
      generatedBy: 'test',
    });
    void h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID);
    await settle();
    expect(h.variationRepo.insert).not.toHaveBeenCalled();
  });
});

describe('VariationGeneratorService fire-and-forget 语义', () => {
  it('LLM 永不 resolve：generateForErrorItem 仍立即返回 promise（bump 链路不被挂住的钉子）', async () => {
    const h = harness();
    h.variation.generate.mockReturnValue(new Promise(() => undefined) as never);
    const p = h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID);
    await settle();
    // 立即返回且已调 LLM；promise 悬挂不 reject
    expect(h.variation.generate).toHaveBeenCalledTimes(1);
    expect(p).toBeInstanceOf(Promise);
  });

  it('LLM 抛错不外溢：promise resolve 且不留行', async () => {
    const h = harness();
    h.variation.generate.mockRejectedValue(new Error('LLM down'));
    await h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID);
    expect(h.variationRepo.insert).not.toHaveBeenCalled();
  });

  it('同 errorItemId 并发去重：inFlight 命中只跑一次 LLM', async () => {
    const h = harness();
    void h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID);
    void h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID); // 第二次命中 inFlight
    await settle();
    expect(h.variation.generate).toHaveBeenCalledTimes(1);
  });

  it('跑完后 inFlight 释放：同 id 再次调用可重跑（前次无 pending 时）', async () => {
    const h = harness();
    await h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID);
    await h.service.generateForErrorItem(ERROR_ITEM_ID, STUDENT_ID);
    expect(h.variation.generate).toHaveBeenCalledTimes(2);
  });
});
