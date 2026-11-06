import { describe, expect, it, vi } from 'vitest';
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
