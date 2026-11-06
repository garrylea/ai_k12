import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { HistoryPracticeService } from './history-practice.service.js';

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
  const variation = { generate: vi.fn() };
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
});
