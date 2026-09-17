import { describe, it, expect, vi } from 'vitest';
import { TrainingSessionsRepository } from './training-sessions.repo';

const mockPool = (opts: { rows?: any[]; affectedRows?: number; insertId?: number } = {}) => {
  const { rows = [], affectedRows = 1, insertId = 7 } = opts;
  return {
    execute: vi.fn().mockImplementation((sql: string) => {
      if (/^\s*INSERT/i.test(sql)) return Promise.resolve([{ insertId, affectedRows }, []]);
      if (/^\s*UPDATE/i.test(sql)) return Promise.resolve([{ affectedRows, changedRows: affectedRows }, []]);
      return Promise.resolve([rows, []]);
    }),
    query: vi.fn().mockResolvedValue([rows, []]),
  };
};

describe('TrainingSessionsRepository.create', () => {
  it('snake_case 入参落库并返回 insertId', async () => {
    const pool = mockPool({ insertId: 41 });
    const repo = new TrainingSessionsRepository(pool as any);
    const id = await repo.create({
      student_id: 9,
      task_code: 'math_targeted',
      subject_id: 1,
      tier_key: '3',
      expected_count: 3,
      ref_type: 'question',
      ref_id: null,
    });
    expect(id).toBe(41);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO training_sessions');
    expect(sql).toContain('(student_id, task_code, subject_id, tier_key, expected_count, ref_type, ref_id)');
    // status / judged_count 走 DB 默认值（in_progress / 0）
    expect(sql).not.toContain('status');
    expect(sql).not.toContain('judged_count');
    expect(params).toEqual([9, 'math_targeted', 1, '3', 3, 'question', null]);
  });
});

describe('TrainingSessionsRepository.findById', () => {
  it('返回首行，无则 null', async () => {
    const row = { id: 41, student_id: 9, tier_key: '3', status: 'in_progress' };
    const pool = mockPool({ rows: [row] });
    const repo = new TrainingSessionsRepository(pool as any);
    expect(await repo.findById(41)).toEqual(row);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM training_sessions');
    expect(sql).toContain('WHERE id = ?');
    expect(params).toEqual([41]);

    const repoEmpty = new TrainingSessionsRepository(mockPool({ rows: [] }) as any);
    expect(await repoEmpty.findById(41)).toBeNull();
  });
});

describe('TrainingSessionsRepository.completeOwned', () => {
  it("仅本人 + in_progress 的会话可完成，返回 affectedRows", async () => {
    const pool = mockPool({ affectedRows: 1 });
    const repo = new TrainingSessionsRepository(pool as any);
    expect(await repo.completeOwned(41, 9)).toBe(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('UPDATE training_sessions');
    expect(sql).toContain("SET status = 'completed'");
    expect(sql).toContain('completed_at = NOW(3)');
    expect(sql).toContain('WHERE id = ? AND student_id = ?');
    expect(sql).toContain("AND status = 'in_progress'");
    expect(params).toEqual([41, 9]);
  });

  it('已完成的会话 affectedRows=0（幂等，调用方据此回查首次发分）', async () => {
    const pool = mockPool({ affectedRows: 0 });
    const repo = new TrainingSessionsRepository(pool as any);
    expect(await repo.completeOwned(41, 9)).toBe(0);
  });
});

describe('TrainingSessionsRepository.incrementJudged', () => {
  it('只累加本人 in_progress 会话的 judged_count（审计留痕，不阻断发分）', async () => {
    const pool = mockPool();
    const repo = new TrainingSessionsRepository(pool as any);
    await repo.incrementJudged(41, 9);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('UPDATE training_sessions');
    expect(sql).toContain('judged_count = judged_count + 1');
    expect(sql).toContain('WHERE id = ? AND student_id = ?');
    expect(sql).toContain("AND status = 'in_progress'");
    expect(params).toEqual([41, 9]);
  });
});
