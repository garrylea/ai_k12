import { describe, it, expect, vi } from 'vitest';
import { ControlsRepository } from './controls.repo';

/** 模拟 mysql2 pool 的双返回形状：写 -> [ResultSetHeader, fields]、读 -> [rows[], fields]。 */
const mockPool = (opts: { rows?: any[]; affectedRows?: number } = {}) => {
  const { rows = [], affectedRows = 1 } = opts;
  return {
    execute: vi.fn().mockImplementation((sql: string) => {
      if (/^\s*INSERT/i.test(sql)) return Promise.resolve([{ insertId: 1, affectedRows }, []]);
      return Promise.resolve([rows, []]);
    }),
  };
};

describe('ControlsRepository.ensure', () => {
  it('INSERT ... ON DUPLICATE KEY UPDATE 是 no-op，不会重置家长改过的开关/汇率', async () => {
    const pool = mockPool();
    const repo = new ControlsRepository(pool as any);

    await repo.ensure(9);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO controls (student_id)');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE student_id = student_id');
    // 关键：UPDATE 子句里不能出现任何业务列，否则一次读操作会重置家长配置
    expect(sql).not.toContain('reward_redemption_enabled');
    expect(sql).not.toContain('points_per_yuan');
    expect(params).toEqual([9]);
  });
});

describe('ControlsRepository.findByStudent', () => {
  it('读到行时把 TINYINT 转成布尔、汇率转成 number', async () => {
    const pool = mockPool({ rows: [{ points_per_yuan: 25, reward_redemption_enabled: 0 }] });
    const repo = new ControlsRepository(pool as any);

    const out = await repo.findByStudent(9);

    expect(out).toEqual({ pointsPerYuan: 25, rewardRedemptionEnabled: false });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('WHERE student_id = ? LIMIT 1');
    expect(params).toEqual([9]);
  });

  it('无行时返回默认值（20 分/元、开启），不抛错、不返回 null', async () => {
    const pool = mockPool({ rows: [] });
    const repo = new ControlsRepository(pool as any);

    await expect(repo.findByStudent(9)).resolves.toEqual({
      pointsPerYuan: 20,
      rewardRedemptionEnabled: true,
    });
  });
});

describe('ControlsRepository.findDailyTimeLimit', () => {
  it('有值 → 数字', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ daily_time_limit_minutes: 60 }], []]) };
    const repo = new ControlsRepository(pool as any);
    expect(await repo.findDailyTimeLimit(9)).toBe(60);
  });

  it('无行 / NULL → null（未设限，不是 0）', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[], []]) };
    const repo = new ControlsRepository(pool as any);
    expect(await repo.findDailyTimeLimit(9)).toBeNull();

    const nullPool = { execute: vi.fn().mockResolvedValue([[{ daily_time_limit_minutes: null }], []]) };
    const repo2 = new ControlsRepository(nullPool as any);
    expect(await repo2.findDailyTimeLimit(9)).toBeNull();
  });
});
