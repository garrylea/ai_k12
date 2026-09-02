import { describe, it, expect, vi } from 'vitest';
import { KnowledgePointsRepository } from './knowledge-points.repo';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
});

describe('KnowledgePointsRepository.findBySubject', () => {
  it('按 subject_id 查平铺列表（id/name/parentKpId/gradeBand 别名映射）', async () => {
    const rows = [
      { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
      { id: 2, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
    ];
    const pool = mockPool(rows);
    const repo = new KnowledgePointsRepository(pool as any);
    const out = await repo.findBySubject(1);
    expect(out).toEqual(rows);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM knowledge_points');
    expect(sql).toContain('subject_id = ?');
    expect(sql).toContain('parent_kp_id AS parentKpId');
    expect(sql).toContain('grade_band AS gradeBand');
    expect(params).toEqual([1]);
  });
});
