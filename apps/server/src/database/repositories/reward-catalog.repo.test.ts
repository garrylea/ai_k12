import { describe, it, expect, vi } from 'vitest';
import { RewardCatalogRepository } from './reward-catalog.repo';
import type { RewardCatalogWriteInput } from './reward-catalog.repo';

const mockPool = (opts: { rows?: any[]; affectedRows?: number; insertId?: number } = {}) => {
  const { rows = [], affectedRows = 1, insertId = 42 } = opts;
  return {
    execute: vi.fn().mockImplementation((sql: string) => {
      if (/^\s*INSERT/i.test(sql)) return Promise.resolve([{ insertId, affectedRows }, []]);
      if (/^\s*UPDATE/i.test(sql)) return Promise.resolve([{ affectedRows, changedRows: affectedRows }, []]);
      return Promise.resolve([rows, []]);
    }),
  };
};

const writeInput = (over: Partial<RewardCatalogWriteInput> = {}): RewardCatalogWriteInput => ({
  name: '换个乐高',
  description: null,
  pointsCost: 80,
  minLevelCode: 'zhutie',
  isActive: true,
  sortOrder: 3,
  ...over,
});

describe('RewardCatalogRepository.listByStudent / findOne', () => {
  it('listByStudent 按 sort_order, id 排序返回全部行', async () => {
    const pool = mockPool({ rows: [{ id: 1 }] });
    const repo = new RewardCatalogRepository(pool as any);

    const out = await repo.listByStudent(9);

    expect(out).toEqual([{ id: 1 }]);
    expect(pool.execute.mock.calls[0][0]).toContain('WHERE student_id = ? ORDER BY sort_order, id');
    expect(pool.execute.mock.calls[0][1]).toEqual([9]);
  });

  it('findOne 的 WHERE 带 student_id，别人的 id 查不到', async () => {
    const pool = mockPool({ rows: [] });
    const repo = new RewardCatalogRepository(pool as any);

    await expect(repo.findOne(9, 5)).resolves.toBeNull();
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('WHERE student_id = ? AND id = ?');
    expect(params).toEqual([9, 5]);
  });
});

describe('RewardCatalogRepository.insert / update', () => {
  it('insert 把布尔转成 1、落全列并返回自增 id', async () => {
    const pool = mockPool({ insertId: 77 });
    const repo = new RewardCatalogRepository(pool as any);

    const id = await repo.insert(9, writeInput({ isActive: false, minLevelCode: null }));

    expect(id).toBe(77);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO reward_catalog');
    expect(params).toEqual([9, '换个乐高', null, 80, null, 0, 3]);
  });

  it('insert 传 conn 时走 conn.execute（批量保存同事务）', async () => {
    const pool = mockPool();
    const repo = new RewardCatalogRepository(pool as any);
    const conn = { execute: vi.fn().mockResolvedValue([{ insertId: 88, affectedRows: 1 }, []]) };

    const id = await repo.insert(9, writeInput(), conn as any);

    expect(id).toBe(88);
    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('update 整行覆盖并返回 affectedRows（0 = id 不存在/不属于该生）', async () => {
    const pool = mockPool({ affectedRows: 0 });
    const repo = new RewardCatalogRepository(pool as any);

    const affected = await repo.update(9, 5, writeInput({ isActive: true }), undefined);

    expect(affected).toBe(0);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('SET name = ?, description = ?, points_cost = ?, min_level_code = ?, is_active = ?, sort_order = ?');
    expect(sql).toContain('WHERE student_id = ? AND id = ?');
    expect(params).toEqual(['换个乐高', null, 80, 'zhutie', 1, 3, 9, 5]);
  });
});

describe('RewardCatalogRepository.deactivateMissing', () => {
  it('有保留 id → NOT IN 软删，且带 is_active = 1 只动在架行', async () => {
    const pool = mockPool();
    const repo = new RewardCatalogRepository(pool as any);

    await repo.deactivateMissing(9, [5, 6, 7]);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('SET is_active = 0');
    expect(sql).toContain('is_active = 1 AND id NOT IN (?, ?, ?)');
    expect(params).toEqual([9, 5, 6, 7]);
  });

  it('空保留列表 → 不生成非法的 NOT IN ()，改为全量下架', async () => {
    const pool = mockPool();
    const repo = new RewardCatalogRepository(pool as any);

    await repo.deactivateMissing(9, []);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).not.toContain('NOT IN');
    expect(sql).toContain('WHERE student_id = ? AND is_active = 1');
    expect(params).toEqual([9]);
  });

  it('传 conn 时走 conn.execute', async () => {
    const pool = mockPool();
    const repo = new RewardCatalogRepository(pool as any);
    const conn = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };

    await repo.deactivateMissing(9, [], conn as any);

    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(pool.execute).not.toHaveBeenCalled();
  });
});
