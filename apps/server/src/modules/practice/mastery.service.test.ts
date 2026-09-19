import { describe, it, expect, vi } from 'vitest';
import { MasteryService } from './mastery.service.js';

const mk = () => ({
  questionsRepo: { findKnowledgePointIdsByQuestion: vi.fn().mockResolvedValue([42]) },
  masteryRepo: { upsertOnJudge: vi.fn().mockResolvedValue(undefined) },
});
const mkSvc = (d = mk()) =>
  new MasteryService(d.questionsRepo as any, d.masteryRepo as any);

describe('MasteryService.recordFromJudge', () => {
  it('答对：每个绑定的 KP 各写一条（isCorrect=true）', async () => {
    const d = mk();
    d.questionsRepo.findKnowledgePointIdsByQuestion.mockResolvedValue([42, 43]);

    await mkSvc(d).recordFromJudge({ studentId: 11, questionId: 330, isCorrect: true });

    expect(d.masteryRepo.upsertOnJudge).toHaveBeenCalledTimes(2);
    expect(d.masteryRepo.upsertOnJudge).toHaveBeenCalledWith(11, 42, true);
    expect(d.masteryRepo.upsertOnJudge).toHaveBeenCalledWith(11, 43, true);
  });

  it('规则③ questionId 为 null → 不查不写', async () => {
    const d = mk();

    await mkSvc(d).recordFromJudge({ studentId: 11, questionId: null, isCorrect: true });

    expect(d.questionsRepo.findKnowledgePointIdsByQuestion).not.toHaveBeenCalled();
    expect(d.masteryRepo.upsertOnJudge).not.toHaveBeenCalled();
  });

  it('规则② isCorrect 为 null（空答案 / 待自评）→ 不查不写', async () => {
    const d = mk();

    await mkSvc(d).recordFromJudge({ studentId: 11, questionId: 330, isCorrect: null });

    expect(d.questionsRepo.findKnowledgePointIdsByQuestion).not.toHaveBeenCalled();
    expect(d.masteryRepo.upsertOnJudge).not.toHaveBeenCalled();
  });

  it('规则① 该题没绑 KP → 不写任何行', async () => {
    const d = mk();
    d.questionsRepo.findKnowledgePointIdsByQuestion.mockResolvedValue([]);

    await mkSvc(d).recordFromJudge({ studentId: 11, questionId: 330, isCorrect: false });

    expect(d.masteryRepo.upsertOnJudge).not.toHaveBeenCalled();
  });

  it('规则④ 仓储抛错 → 不冒泡（埋点不阻断判题）', async () => {
    const d = mk();
    d.masteryRepo.upsertOnJudge.mockRejectedValue(new Error('db down'));

    await expect(
      mkSvc(d).recordFromJudge({ studentId: 11, questionId: 330, isCorrect: true }),
    ).resolves.toBeUndefined();
  });

  it('规则④ 取 KP 抛错 → 同样不冒泡', async () => {
    const d = mk();
    d.questionsRepo.findKnowledgePointIdsByQuestion.mockRejectedValue(new Error('db down'));

    await expect(
      mkSvc(d).recordFromJudge({ studentId: 11, questionId: 330, isCorrect: true }),
    ).resolves.toBeUndefined();
  });
});
