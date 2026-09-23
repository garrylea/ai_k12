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

describe('KnowledgePointsRepository.countAvailableQuestionsByKp', () => {
  it('一次分组查询返回 kp_id -> 可抽题数 的 Map', async () => {
    const pool = mockPool([
      { kp_id: 11, n: 7 },
      { kp_id: 12, n: 0 },
      { kp_id: 13, n: '3' },
    ]);
    const repo = new KnowledgePointsRepository(pool as any);

    const result = await repo.countAvailableQuestionsByKp(9, 1);

    expect(result.get(11)).toBe(7);
    expect(result.get(12)).toBe(0);
    // DECIMAL/COUNT 可能以字符串回来，必须 Number() 归一
    expect(result.get(13)).toBe(3);
    expect(result.get(999)).toBeUndefined();
  });

  it('SQL 谓词与 findRandomByKpAndType 同源（is_active / 空答案 / 不再展示排除）', async () => {
    const pool = mockPool([]);
    const repo = new KnowledgePointsRepository(pool as any);

    await repo.countAvailableQuestionsByKp(9, 1);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('JOIN question_knowledge_points qkp ON qkp.question_id = q.id');
    expect(sql).toContain('LEFT JOIN student_hidden_questions shq');
    expect(sql).toContain('q.subject_id = ?');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain("q.answer <> ''");
    expect(sql).toContain('shq.id IS NULL');
    expect(sql).toContain('GROUP BY qkp.knowledge_point_id');
    // 参数顺序：LEFT JOIN 的 studentId 在前，WHERE 的 subjectId 在后
    expect(params).toEqual([9, 1]);
  });
});
