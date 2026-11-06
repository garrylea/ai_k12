import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, Logger } from '@nestjs/common';
import { HistoryPracticeService } from './history-practice.service.js';
import { computeContentHash } from '../../common/utils/content-hash.util.js';

const mkQ = (over: any = {}) => ({
  id: 100, subject_id: 1, type: 'choice', difficulty: 2, content: '题干',
  options: '[{"label":"A","text":"1"}]', answer: 'A', explanation: '解析',
  material_text: null, is_active: 1, ...over,
});

function make() {
  const questionsRepo = {
    findById: vi.fn().mockResolvedValue(mkQ()),
    findKpIdsByQuestionIds: vi.fn().mockResolvedValue(new Map()),
    findRandomByKpTypeDifficulty: vi.fn().mockResolvedValue([]),
    findOrCreate: vi.fn(),
    bindKnowledgePoint: vi.fn(),
  };
  const kpRepo = { findById: vi.fn() };
  // 默认 AI 无产出：题库抽满的用例不会走到补题，抽不满的用例也不会因 mock 返回 undefined 而崩。
  const variation = { generate: vi.fn().mockResolvedValue({ variations: [] }) };
  const trainingSessionsRepo = { create: vi.fn().mockResolvedValue(88) };
  const pointRules = { listTierKeys: vi.fn().mockResolvedValue(['1', '2', '3', '5', '10']) };
  const svc = new HistoryPracticeService(
    questionsRepo as never, kpRepo as never, variation as never,
    trainingSessionsRepo as never, pointRules as never,
  );
  return { svc, questionsRepo, kpRepo, variation, trainingSessionsRepo, pointRules };
}

describe('HistoryPracticeService.loadRedoQuestion', () => {
  it('返回白名单字段，不含答案', async () => {
    const { svc } = make();
    const q = await svc.loadRedoQuestion(100);
    expect(q).toEqual({
      questionId: 100, text: '题干', type: 'choice',
      options: [{ label: 'A', text: '1' }], materialText: null,
    });
    expect(q).not.toHaveProperty('answer');
    expect(q).not.toHaveProperty('explanation');
  });

  it('材料题带回 materialText', async () => {
    const { svc, questionsRepo } = make();
    questionsRepo.findById.mockResolvedValue(mkQ({ material_text: '阅读下面的材料' }));
    const q = await svc.loadRedoQuestion(100);
    expect(q?.materialText).toBe('阅读下面的材料');
  });

  it('题目下架 / 不存在 -> null', async () => {
    const { svc, questionsRepo } = make();
    questionsRepo.findById.mockResolvedValue(mkQ({ is_active: 0 }));
    await expect(svc.loadRedoQuestion(100)).resolves.toBeNull();

    questionsRepo.findById.mockResolvedValue(null);
    await expect(svc.loadRedoQuestion(100)).resolves.toBeNull();
  });
});

describe('HistoryPracticeService.startSimilar', () => {
  it('同类型：题库抽满 3 题 -> 建 3 题档会话', async () => {
    const { svc, questionsRepo, kpRepo, trainingSessionsRepo } = make();
    questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));
    kpRepo.findById.mockResolvedValue({ id: 28, name: '反比例函数' });
    questionsRepo.findRandomByKpTypeDifficulty
      .mockResolvedValueOnce([{ id: 201, content: '题1', type: 'choice', options: null, material_text: null }])
      .mockResolvedValueOnce([
        { id: 202, content: '题2', type: 'choice', options: null, material_text: null },
        { id: 203, content: '题3', type: 'choice', options: null, material_text: null },
      ]);
    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });
    expect(r.sessionId).toBe(88);
    expect(r.questions.map((q) => q.questionId)).toEqual([201, 202, 203]);
    expect(trainingSessionsRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      task_code: 'math_targeted', tier_key: '3', expected_count: 3,
    }));
    expect(r.title).toBe('同类练习：反比例函数 · 3 题');
  });

  it('同类型：实际只有 2 题（请求 5）-> 按 2 题档发分', async () => {
    const { svc, questionsRepo, kpRepo, trainingSessionsRepo } = make();
    questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));
    kpRepo.findById.mockResolvedValue({ id: 28, name: '反比例函数' });
    questionsRepo.findRandomByKpTypeDifficulty
      .mockResolvedValueOnce([{ id: 201, content: '题1', type: 'choice', options: null, material_text: null }])
      .mockResolvedValueOnce([{ id: 202, content: '题2', type: 'choice', options: null, material_text: null }]);
    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 5 });
    expect(r.questions).toHaveLength(2);
    expect(trainingSessionsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ tier_key: '2' }));
  });

  it('同类型：0 题 -> 不建会话', async () => {
    const { svc, questionsRepo, kpRepo, trainingSessionsRepo } = make();
    questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));
    kpRepo.findById.mockResolvedValue({ id: 28, name: '反比例函数' });
    questionsRepo.findRandomByKpTypeDifficulty.mockResolvedValue([]);
    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });
    expect(r.questions).toEqual([]);
    expect(r.sessionId).toBeNull();
    expect(trainingSessionsRepo.create).not.toHaveBeenCalled();
  });

  it('化学 / 非法题量 -> 400', async () => {
    const { svc } = make();
    await expect(svc.startSimilar({ studentId: 7, subjectId: 5, questionId: 100, count: 3 }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 4 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('题量不在学生可用档位白名单 -> 400', async () => {
    const { svc, pointRules } = make();
    pointRules.listTierKeys.mockResolvedValue(['1', '3']);
    await expect(svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 2 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('种子题无知识点 -> 400', async () => {
    const { svc, questionsRepo, kpRepo } = make();
    questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map());
    await expect(svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(kpRepo.findById).not.toHaveBeenCalled();
  });

  it('种子题学科不符 / 无标准答案 -> 400', async () => {
    const { svc, questionsRepo } = make();
    questionsRepo.findById.mockResolvedValue(mkQ({ subject_id: 4 }));
    await expect(svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 }))
      .rejects.toBeInstanceOf(BadRequestException);

    questionsRepo.findById.mockResolvedValue(mkQ({ answer: '' }));
    await expect(svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('第二轮按 [d-1,d,d+1] 放宽，并排除种子题与首轮已选', async () => {
    const { svc, questionsRepo, kpRepo } = make();
    questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));
    kpRepo.findById.mockResolvedValue({ id: 28, name: '反比例函数' });
    questionsRepo.findRandomByKpTypeDifficulty
      .mockResolvedValueOnce([{ id: 201, content: '题1', type: 'choice', options: null, material_text: null }])
      .mockResolvedValueOnce([]);

    await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });

    expect(questionsRepo.findRandomByKpTypeDifficulty).toHaveBeenNthCalledWith(
      1, 7, 1, 28, 'choice', [2], 3, [100],
    );
    expect(questionsRepo.findRandomByKpTypeDifficulty).toHaveBeenNthCalledWith(
      2, 7, 1, 28, 'choice', [1, 2, 3], 2, [100, 201],
    );
  });

  it('种子难度 5（超出 1..3）：阶梯先收敛为 [3]，绝不传空数组（否则 SQL IN () 500）', async () => {
    const { svc, questionsRepo, kpRepo } = make();
    questionsRepo.findById.mockResolvedValue(mkQ({ difficulty: 5 }));
    questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));
    kpRepo.findById.mockResolvedValue({ id: 28, name: '反比例函数' });
    questionsRepo.findRandomByKpTypeDifficulty
      .mockResolvedValueOnce([{ id: 201, content: '题1', type: 'choice', options: null, material_text: null }])
      .mockResolvedValueOnce([]);

    await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });

    expect(questionsRepo.findRandomByKpTypeDifficulty).toHaveBeenNthCalledWith(
      2, 7, 1, 28, 'choice', [3], 2, [100, 201],
    );
  });

  it('题够但没有 ≤ 实际题数的可用档位 -> 照常出题、不建会话', async () => {
    const { svc, questionsRepo, kpRepo, pointRules, trainingSessionsRepo } = make();
    questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));
    kpRepo.findById.mockResolvedValue({ id: 28, name: '反比例函数' });
    pointRules.listTierKeys.mockResolvedValue(['5', '10']);
    questionsRepo.findRandomByKpTypeDifficulty
      .mockResolvedValueOnce([{ id: 201, content: '题1', type: 'choice', options: null, material_text: null }]);

    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 5 });

    expect(r.sessionId).toBeNull();
    expect(r.questions).toHaveLength(1);
    expect(trainingSessionsRepo.create).not.toHaveBeenCalled();
  });

  it('题库不够时 AI 补题并入库（source=history_practice）', async () => {
    const { svc, questionsRepo, kpRepo, variation } = make();
    questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));
    kpRepo.findById.mockResolvedValue({ id: 28, name: '反比例函数' });
    questionsRepo.findRandomByKpTypeDifficulty.mockResolvedValue([]);
    variation.generate.mockResolvedValue({
      variations: [
        { content: 'AI题1', answer: 'B', explanation: '解析', difficulty: 2, variationType: '换数', options: [{ label: 'A', text: '1', isCorrect: false }, { label: 'B', text: '2', isCorrect: true }] },
        { content: 'AI题2', answer: 'A', explanation: '解析', difficulty: 2, variationType: '换数', options: [{ label: 'A', text: '1', isCorrect: true }, { label: 'B', text: '2', isCorrect: false }] },
      ],
    });
    questionsRepo.findOrCreate
      .mockResolvedValueOnce({ id: 301, created: true })
      .mockResolvedValueOnce({ id: 302, created: true });
    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 2 });
    expect(r.questions.map((q) => q.questionId)).toEqual([301, 302]);
    expect(questionsRepo.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      source: 'history_practice', subject_id: 1,
    }));
    expect(questionsRepo.bindKnowledgePoint).toHaveBeenCalledWith(301, 28, 'primary');
  });

  it('建会话失败只 warn：照常返回题目，sessionId=null', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { svc, questionsRepo, kpRepo, trainingSessionsRepo } = make();
    questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));
    kpRepo.findById.mockResolvedValue({ id: 28, name: '反比例函数' });
    questionsRepo.findRandomByKpTypeDifficulty
      .mockResolvedValueOnce([{ id: 201, content: '题1', type: 'choice', options: null, material_text: null }]);
    trainingSessionsRepo.create.mockRejectedValue(new Error('db down'));

    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });

    expect(r.questions).toHaveLength(1);
    expect(r.sessionId).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
    warn.mockRestore();
  });
});

describe('HistoryPracticeService.startSimilar — AI 补题', () => {
  const aiChoice = (content: string, answer: 'A' | 'B' = 'A') => ({
    content,
    answer,
    explanation: '解析',
    difficulty: 2 as const,
    variationType: '换数' as const,
    options: [
      { label: 'A', text: '1', isCorrect: answer === 'A' },
      { label: 'B', text: '2', isCorrect: answer === 'B' },
      { label: 'C', text: '3', isCorrect: false },
      { label: 'D', text: '4', isCorrect: false },
    ],
  });

  function setup(opts: { subjectId?: number; bank?: any[]; seedType?: string } = {}) {
    const ctx = make();
    const subjectId = opts.subjectId ?? 1;
    const seedType = opts.seedType ?? 'choice';
    if (subjectId === 4) {
      ctx.questionsRepo.findById.mockResolvedValue(mkQ({ subject_id: 4, type: seedType }));
    } else if (seedType !== 'choice') {
      ctx.questionsRepo.findById.mockResolvedValue(mkQ({ type: seedType }));
    }
    ctx.questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));
    ctx.kpRepo.findById.mockResolvedValue({ id: 28, name: '反比例函数' });
    // 首轮给 `bank`，阶梯轮给空（真实仓储会排除已选，mock 不会——只给首轮才等价）。
    ctx.questionsRepo.findRandomByKpTypeDifficulty.mockReset();
    ctx.questionsRepo.findRandomByKpTypeDifficulty
      .mockResolvedValueOnce(opts.bank ?? [])
      .mockResolvedValue([]);
    return ctx;
  }

  it('种子无标准答案：题库照样出题，不再 400', async () => {
    const { svc, questionsRepo } = setup({
      bank: [{ id: 201, content: '题库题', type: 'choice', options: null, material_text: null }],
    });
    questionsRepo.findById.mockResolvedValue(mkQ({ answer: '' }));

    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 1 });

    expect(r.questions.map((q) => q.questionId)).toEqual([201]);
  });

  it('种子无标准答案：AI 补题仍被调用，且 answer 传空串', async () => {
    const { svc, questionsRepo, variation } = setup();
    questionsRepo.findById.mockResolvedValue(mkQ({ answer: '' }));
    variation.generate.mockResolvedValue({ variations: [aiChoice('AI题1')] });
    questionsRepo.findOrCreate.mockResolvedValue({ id: 301, created: true });

    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 1 });

    expect(variation.generate).toHaveBeenCalledWith(expect.objectContaining({
      originalQuestion: expect.objectContaining({ answer: '' }),
    }));
    expect(r.questions.map((q) => q.questionId)).toEqual([301]);
  });

  it('入库行：subject/type/difficulty 取种子题，options 剥掉 isCorrect，content_hash 去重键', async () => {
    const { svc, questionsRepo, variation } = setup();
    variation.generate.mockResolvedValue({ variations: [aiChoice('AI题1', 'B')] });
    questionsRepo.findOrCreate.mockResolvedValue({ id: 301, created: true });

    await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 2 });

    expect(questionsRepo.findOrCreate).toHaveBeenCalledTimes(1);
    const row = questionsRepo.findOrCreate.mock.calls[0][0];
    expect(row).toMatchObject({
      subject_id: 1,
      type: 'choice',
      difficulty: 2,
      content: 'AI题1',
      answer: 'B',
      explanation: '解析',
      source: 'history_practice',
      content_hash: computeContentHash('AI题1'),
    });
    expect(JSON.parse(row.options)).toEqual([
      { label: 'A', text: '1' },
      { label: 'B', text: '2' },
      { label: 'C', text: '3' },
      { label: 'D', text: '4' },
    ]);
    // 入库行绝不含 isCorrect（防答案泄漏）
    expect(row.options).not.toContain('isCorrect');
  });

  it('题目载荷：AI 题带 label/text 选项、materialText=null', async () => {
    const { svc, questionsRepo, variation } = setup();
    variation.generate.mockResolvedValue({ variations: [aiChoice('AI题1', 'B')] });
    questionsRepo.findOrCreate.mockResolvedValue({ id: 301, created: true });

    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 2 });

    expect(r.questions).toEqual([{
      questionId: 301, text: 'AI题1', type: 'choice',
      options: [
        { label: 'A', text: '1' }, { label: 'B', text: '2' },
        { label: 'C', text: '3' }, { label: 'D', text: '4' },
      ],
      materialText: null,
    }]);
    expect(r.questions[0]).not.toHaveProperty('answer');
    expect(r.questions[0]).not.toHaveProperty('explanation');
  });

  it('多选：answer 归一为正确项 label 排序拼接后入库', async () => {
    const { svc, questionsRepo, variation } = setup({ seedType: 'multi_choice' });
    variation.generate.mockResolvedValue({
      variations: [{
        content: 'AI多选', answer: 'DB', explanation: '解析', difficulty: 2, variationType: '换数',
        options: [
          { label: 'A', text: '甲', isCorrect: false },
          { label: 'B', text: '乙', isCorrect: true },
          { label: 'D', text: '丁', isCorrect: true },
        ],
      }],
    });
    questionsRepo.findOrCreate.mockResolvedValue({ id: 301, created: true });

    await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 2 });

    expect(questionsRepo.findOrCreate.mock.calls[0][0]).toMatchObject({ type: 'multi_choice', answer: 'BD' });
  });

  it('校验不通过的 AI 题跳过（不入库）', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { svc, questionsRepo, variation } = setup();
    variation.generate.mockResolvedValue({
      variations: [
        // choice 却有两个正确项
        { content: '坏题', answer: 'A', explanation: '', difficulty: 2, variationType: '换数', options: [
          { label: 'A', text: '1', isCorrect: true }, { label: 'B', text: '2', isCorrect: true },
        ] },
        aiChoice('好题', 'A'),
      ],
    });
    questionsRepo.findOrCreate.mockResolvedValue({ id: 301, created: true });

    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });

    expect(questionsRepo.findOrCreate).toHaveBeenCalledTimes(1);
    expect(r.questions.map((q) => q.questionId)).toEqual([301]);
    warn.mockRestore();
  });

  it('复用已有题（created=false）不挂 primary，也不重复追加', async () => {
    const { svc, questionsRepo, variation } = setup();
    variation.generate.mockResolvedValue({ variations: [aiChoice('AI题1')] });
    questionsRepo.findOrCreate.mockResolvedValue({ id: 301, created: false });

    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 2 });

    expect(r.questions.map((q) => q.questionId)).toEqual([301]);
    expect(questionsRepo.bindKnowledgePoint).not.toHaveBeenCalled();
  });

  it('AI 题命中题库已选题 id -> 跳过，不重复出题', async () => {
    const { svc, questionsRepo, variation } = setup({
      bank: [{ id: 201, content: '题库题', type: 'choice', options: null, material_text: null }],
    });
    variation.generate.mockResolvedValue({ variations: [aiChoice('AI题1'), aiChoice('AI题2', 'B')] });
    // 第一道撞上已选题 201；第二道是新题 301
    questionsRepo.findOrCreate
      .mockResolvedValueOnce({ id: 201, created: false })
      .mockResolvedValueOnce({ id: 301, created: true });

    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });

    expect(r.questions.map((q) => q.questionId)).toEqual([201, 301]);
    expect(questionsRepo.bindKnowledgePoint).toHaveBeenCalledTimes(1);
    expect(questionsRepo.bindKnowledgePoint).toHaveBeenCalledWith(301, 28, 'primary');
  });

  it('AI 调用失败 -> 只用题库题，端点不抛错', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { svc, questionsRepo, variation } = setup({
      bank: [{ id: 201, content: '题库题', type: 'choice', options: null, material_text: null }],
    });
    variation.generate.mockRejectedValue(new Error('upstream 502'));

    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });

    expect(r.questions.map((q) => q.questionId)).toEqual([201]);
    expect(questionsRepo.findOrCreate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('upstream 502'));
    warn.mockRestore();
  });

  it('AI 0 题 + 题库 0 题 -> 空响应，不建会话', async () => {
    const { svc, trainingSessionsRepo } = setup();
    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });
    expect(r).toEqual({ questions: [], sessionId: null, title: '同类练习：反比例函数 · 0 题' });
    expect(trainingSessionsRepo.create).not.toHaveBeenCalled();
  });

  it('请求参数：subject 按学科映射、count=缺口、targetDifficulty=种子难度、20s 硬上限、关闭重试', async () => {
    const [mathCtx, physicsCtx] = [setup(), setup({ subjectId: 4 })];
    await mathCtx.svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 2 });
    await physicsCtx.svc.startSimilar({ studentId: 7, subjectId: 4, questionId: 100, count: 2 });

    expect(mathCtx.variation.generate).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'math', count: 2, timeoutMs: 20000, maxRetries: 0,
      targetDifficulty: 2,
      originalQuestion: { content: '题干', answer: 'A', difficulty: 2 },
      knowledgePoint: { id: '28', name: '反比例函数' },
    }));
    expect(physicsCtx.variation.generate).toHaveBeenCalledWith(expect.objectContaining({ subject: 'physics' }));
  });

  // 修复轮（2026-11-06）：AI 循环里的 DB 写失败不得把「题库已有题」的响应变成 500。
  it('AI 入库失败 -> warn 后继续，保留题库题、不 500', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { svc, questionsRepo, variation } = setup({
      bank: [{ id: 201, content: '题库题', type: 'choice', options: null, material_text: null }],
    });
    variation.generate.mockResolvedValue({ variations: [aiChoice('AI题1'), aiChoice('AI题2', 'B')] });
    questionsRepo.findOrCreate
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce({ id: 302, created: true });

    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });

    expect(r.questions.map((q) => q.questionId)).toEqual([201, 302]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('insert failed'));
    warn.mockRestore();
  });

  it('AI 题挂知识点失败 -> 跳过该题，保留其余 AI 题与题库题、不 500', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { svc, questionsRepo, variation } = setup();
    variation.generate.mockResolvedValue({ variations: [aiChoice('AI题1'), aiChoice('AI题2', 'B')] });
    questionsRepo.findOrCreate
      .mockResolvedValueOnce({ id: 301, created: true })
      .mockResolvedValueOnce({ id: 302, created: true });
    questionsRepo.bindKnowledgePoint
      .mockRejectedValueOnce(new Error('bind failed'))
      .mockResolvedValueOnce(undefined);

    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 2 });

    expect(r.questions.map((q) => q.questionId)).toEqual([302]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bind failed'));
    warn.mockRestore();
  });

  it('AI 返回原题（命中种子题 id）-> 跳过，不进入练习集', async () => {
    const { svc, questionsRepo, variation } = setup();
    variation.generate.mockResolvedValue({ variations: [aiChoice('题干'), aiChoice('AI题2', 'B')] });
    // 第一道与种子题同文 -> findOrCreate 撞 hash 返回 100
    questionsRepo.findOrCreate
      .mockResolvedValueOnce({ id: 100, created: false })
      .mockResolvedValueOnce({ id: 301, created: true });

    const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 2 });

    expect(r.questions.map((q) => q.questionId)).toEqual([301]);
  });

  it('AI 超 20s 未返回 -> 走题库题；超时后迟到的结果不再入库', async () => {
    vi.useFakeTimers();
    try {
      const { svc, questionsRepo, variation } = setup({
        bank: [{ id: 201, content: '题库题', type: 'choice', options: null, material_text: null }],
      });
      let resolveAi!: (v: unknown) => void;
      variation.generate.mockReturnValue(new Promise((res) => { resolveAi = res; }));
      questionsRepo.findOrCreate.mockResolvedValue({ id: 301, created: true });

      const p = svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });
      await vi.advanceTimersByTimeAsync(20000);
      const r = await p;

      expect(r.questions.map((q) => q.questionId)).toEqual([201]);

      // 迟到的 AI 结果：竞速已结束，不得再写库
      resolveAi({ variations: [aiChoice('迟到题')] });
      await Promise.resolve();
      await Promise.resolve();
      expect(questionsRepo.findOrCreate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
