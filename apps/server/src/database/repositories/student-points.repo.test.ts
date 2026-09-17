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
    expect(sql).toContain('AS new');
    expect(sql).toContain(
      'ON DUPLICATE KEY UPDATE total_earned = student_points.total_earned + new.total_earned',
    );
    expect(sql).toContain('balance = student_points.balance + new.balance');
    expect(sql).not.toContain('VALUES(');
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

describe('StudentPointsRepository.deductBalanceIfEnough', () => {
  it('条件 UPDATE：SQL 带 balance >= ? 守卫，只 SET balance、不含 total_earned', async () => {
    const pool = mockPool();
    const repo = new StudentPointsRepository(pool as any);
    const affected = await repo.deductBalanceIfEnough(9, 100);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('UPDATE student_points');
    expect(sql).toContain('SET balance = balance - ?');
    expect(sql).toContain('WHERE student_id = ? AND balance >= ?');
    expect(sql).not.toContain('total_earned');
    expect(params).toEqual([100, 9, 100]);
    expect(affected).toBe(1);
  });

  it('余额不足（affectedRows=0）原样返回 0，由服务层判 3001', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 0, changedRows: 0 }, []]) };
    const repo = new StudentPointsRepository(pool as any);
    expect(await repo.deductBalanceIfEnough(9, 100)).toBe(0);
  });

  it('传入 conn 时走 conn.execute，与兑换单/流水同事务', async () => {
    const pool = mockPool();
    const repo = new StudentPointsRepository(pool as any);
    const conn = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    const affected = await repo.deductBalanceIfEnough(9, 100, conn as any);
    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(pool.execute).not.toHaveBeenCalled();
    expect(affected).toBe(1);
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
    expect(sql).toContain('AS new');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE total_earned = new.total_earned');
    expect(sql).toContain('balance = new.balance');
    expect(sql).not.toContain('VALUES(');
    expect(sql).not.toContain('total_earned = total_earned +');
    expect(params).toEqual([9, 520, 320]);
  });
});
