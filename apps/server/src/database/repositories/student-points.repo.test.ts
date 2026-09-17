import { describe, it, expect, vi } from 'vitest';
import { StudentPointsRepository } from './student-points.repo';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockImplementation((sql: string) => {
    if (/^\s*INSERT/i.test(sql)) return Promise.resolve([{ insertId: 0, affectedRows: 1 }, []]);
    if (/^\s*UPDATE/i.test(sql)) return Promise.resolve([{ affectedRows: 1, changedRows: 1 }, []]);
    return Promise.resolve([rows, []]);
  }),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('StudentPointsRepository.upsertDelta', () => {
  it('按 student_id upsert，两个累加器都在 SQL 里做加法', async () => {
    const pool = mockPool();
    const repo = new StudentPointsRepository(pool as any);
    await repo.upsertDelta(9, 8, 8);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO student_points');
    expect(sql).toContain('(student_id, total_earned, balance)');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE total_earned = total_earned + VALUES(total_earned)');
    expect(sql).toContain('balance = balance + VALUES(balance)');
    expect(params).toEqual([9, 8, 8]);
  });

  it('兑换场景 earnedDelta=0：只减余额，不加累计', async () => {
    const pool = mockPool();
    const repo = new StudentPointsRepository(pool as any);
    await repo.upsertDelta(9, 0, -100);
    const [, params] = pool.execute.mock.calls[0];
    expect(params).toEqual([9, 0, -100]);
  });

  it('传入 conn 时走 conn.execute，供调用方与流水同事务', async () => {
    const pool = mockPool();
    const repo = new StudentPointsRepository(pool as any);
    const conn = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    await repo.upsertDelta(9, 2, 2, conn as any);
    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

describe('StudentPointsRepository.find', () => {
  it('返回 totalEarned / balance', async () => {
    const pool = mockPool([{ student_id: 9, total_earned: 520, balance: 320 }]);
    const repo = new StudentPointsRepository(pool as any);
    expect(await repo.find(9)).toEqual({ totalEarned: 520, balance: 320 });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('total_earned');
    expect(sql).toContain('balance');
    expect(sql).toContain('WHERE student_id = ?');
    expect(params).toEqual([9]);
  });

  it('无行时返回 { totalEarned: 0, balance: 0 }，不抛错也不返回 null（新学生还没发过分）', async () => {
    const repo = new StudentPointsRepository(mockPool([]) as any);
    expect(await repo.find(9)).toEqual({ totalEarned: 0, balance: 0 });
  });
});

describe('StudentPointsRepository.overwrite', () => {
  it('重建脚本：直接覆盖快照，不做增量', async () => {
    const pool = mockPool();
    const repo = new StudentPointsRepository(pool as any);
    await repo.overwrite(9, 520, 320);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO student_points');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE total_earned = VALUES(total_earned)');
    expect(sql).toContain('balance = VALUES(balance)');
    expect(sql).not.toContain('total_earned = total_earned +');
    expect(params).toEqual([9, 520, 320]);
  });
});
