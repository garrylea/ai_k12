import { describe, it, expect, vi } from 'vitest';
import { PointRedemptionsRepository } from './point-redemptions.repo';

const mockPool = (opts: { rows?: any[]; affectedRows?: number; insertId?: number } = {}) => {
  const { rows = [], affectedRows = 1, insertId = 55 } = opts;
  return {
    execute: vi.fn().mockImplementation((sql: string) => {
      if (/^\s*INSERT/i.test(sql)) return Promise.resolve([{ insertId, affectedRows }, []]);
      if (/^\s*UPDATE/i.test(sql)) return Promise.resolve([{ affectedRows, changedRows: affectedRows }, []]);
      return Promise.resolve([rows, []]);
    }),
    query: vi.fn().mockResolvedValue([rows, []]),
  };
};

const insertInput = () => ({
  student_id: 9,
  type: 'reward' as const,
  points_spent: 80,
  cash_amount: null,
  reward_catalog_id: 5,
  reward_name: '换个乐高',
  note: null,
});

describe('PointRedemptionsRepository.insert', () => {
  it("落一条 status='pending' 的兑换单，可空字段缺省写 null", async () => {
    const pool = mockPool({ insertId: 55 });
    const repo = new PointRedemptionsRepository(pool as any);

    const id = await repo.insert({ student_id: 9, type: 'cash', points_spent: 100 });

    expect(id).toBe(55);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO point_redemptions');
    expect(sql).toContain(
      '(student_id, type, points_spent, cash_amount, reward_catalog_id, reward_name, note, status)',
    );
    expect(sql).toContain("'pending'");
    expect(params).toEqual([9, 'cash', 100, null, null, null, null]);
  });

  it('传 conn 时走 conn.execute', async () => {
    const pool = mockPool();
    const repo = new PointRedemptionsRepository(pool as any);
    const conn = { execute: vi.fn().mockResolvedValue([{ insertId: 66, affectedRows: 1 }, []]) };

    const id = await repo.insert(insertInput(), conn as any);

    expect(id).toBe(66);
    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

describe('PointRedemptionsRepository.setLedgerId', () => {
  it('回写 ledger_id 并带 student_id 归属校验', async () => {
    const pool = mockPool({ affectedRows: 1 });
    const repo = new PointRedemptionsRepository(pool as any);

    const affected = await repo.setLedgerId(9, 55, 900);

    expect(affected).toBe(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('SET ledger_id = ? WHERE student_id = ? AND id = ?');
    expect(params).toEqual([900, 9, 55]);
  });
});

describe('PointRedemptionsRepository.listByStudent / countByStudent', () => {
  it('分页用 query（execute 的 LIMIT ? 会报错），id 倒序', async () => {
    const pool = mockPool({ rows: [{ id: 2 }, { id: 1 }] });
    const repo = new PointRedemptionsRepository(pool as any);

    const out = await repo.listByStudent(9, 20, 40);

    expect(out).toEqual([{ id: 2 }, { id: 1 }]);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.execute).not.toHaveBeenCalled();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('ORDER BY id DESC');
    expect(sql).toContain('LIMIT ? OFFSET ?');
    expect(params).toEqual([9, 20, 40]);
  });

  it('countByStudent 返回数字', async () => {
    const pool = mockPool({ rows: [{ count: 3 }] });
    const repo = new PointRedemptionsRepository(pool as any);

    await expect(repo.countByStudent(9)).resolves.toBe(3);
  });
});

describe('PointRedemptionsRepository.updateStatus', () => {
  it('SET 只出现 status / fulfilled_at —— 绝不碰积分列', async () => {
    const pool = mockPool({ affectedRows: 1 });
    const repo = new PointRedemptionsRepository(pool as any);
    const at = new Date(2026, 8, 17, 12, 0, 0);

    const affected = await repo.updateStatus(9, 55, 'fulfilled', at);

    expect(affected).toBe(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('SET status = ?, fulfilled_at = ?');
    expect(sql).not.toContain('points_spent');
    expect(sql).not.toContain('student_points');
    expect(sql).toContain('WHERE student_id = ? AND id = ?');
    expect(params).toEqual(['fulfilled', at, 9, 55]);
  });

  it('回到 pending 时 fulfilled_at 传 null', async () => {
    const pool = mockPool();
    const repo = new PointRedemptionsRepository(pool as any);

    await repo.updateStatus(9, 55, 'pending', null);

    expect(pool.execute.mock.calls[0][1]).toEqual(['pending', null, 9, 55]);
  });
});
