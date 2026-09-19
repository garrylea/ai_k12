import { describe, it, expect, vi } from 'vitest';
import { ParentMasteryService } from './parent-mastery.service.js';

const mkRepo = () => ({
  listWeakest: vi.fn().mockResolvedValue([]),
  countQuestionCoverage: vi.fn().mockResolvedValue({ coveredQuestions: 203, totalQuestions: 530 }),
});
const mkSvc = (repo = mkRepo()) => new ParentMasteryService(repo as any);

describe('ParentMasteryService', () => {
  it('返回 items + 三个覆盖率计数；uncovered = total - covered', async () => {
    const repo = mkRepo();
    repo.listWeakest.mockResolvedValue([
      { knowledgePointId: 42, name: '分数加减', masteryScore: 0.5, level: 2,
        correctCount: 3, errorCount: 3, lastSeenAt: new Date('2026-09-16T10:00:00Z') },
    ]);

    const out = await mkSvc(repo).getMastery(11, 10);

    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ knowledgePointId: 42, name: '分数加减', masteryScore: 0.5, level: 2 });
    expect(out).toMatchObject({ coveredQuestions: 203, totalQuestions: 530, uncovered: 327 });
    expect(repo.listWeakest).toHaveBeenCalledWith(11, 10);
  });

  it('无掌握度数据 → items 空，但覆盖率计数照给（否则家长不知道是「没数据」还是「没覆盖」）', async () => {
    const out = await mkSvc().getMastery(11, 10);

    expect(out.items).toEqual([]);
    expect(out.uncovered).toBe(327);
  });

  it('lastSeenAt 为 null 时原样传 null（不编成 0）', async () => {
    const repo = mkRepo();
    repo.listWeakest.mockResolvedValue([
      { knowledgePointId: 42, name: 'x', masteryScore: 0, level: 0, correctCount: 0, errorCount: 0, lastSeenAt: null },
    ]);

    const out = await mkSvc(repo).getMastery(11, 10);

    expect(out.items[0].lastSeenAt).toBeNull();
  });
});
