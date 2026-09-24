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

/** SELECT 的列清单（按顺序）。用来钉「这条读只取哪几列」，比断言整条 SQL 字符串耐改。 */
function selectList(sql: string): string[] {
  const list = /^\s*SELECT\s+(.+?)\s+FROM\s/i.exec(sql)?.[1] ?? '';
  return list.split(',').map((c) => c.trim());
}

/**
 * 把 `UPDATE ... SET` 子句里的 `列 = ?` 与参数**按列名配对**。
 *
 * 为什么不直接断言 params 数组字面量：那只证明「代码与自己一致」。`update` 的 SET 由白名单
 * 顺序拼出，某两条 `sets.push` 写反时（列与值张冠李戴）位置断言照样全绿——家长改「切走阈值」
 * 会静默写进「无操作阈值」。按列名配对才拦得住这一类（`safety-alerts.repo.test.ts` 的
 * `zipWhere` 同理）。
 */
function zipSet(sql: string, params: unknown[]): Record<string, unknown> {
  const setClause = /SET\s+(.+?)\s+WHERE\b/is.exec(sql)?.[1] ?? '';
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const m of setClause.matchAll(/(\w+)\s*=\s*\?/g)) out[m[1]] = params[i++];
  return out;
}

/** SET 子句吃掉之后剩下的参数（`update` 里就是 WHERE 的 studentId）。 */
function restAfterSet(sql: string, params: unknown[]): unknown[] {
  const setClause = /SET\s+(.+?)\s+WHERE\b/is.exec(sql)?.[1] ?? '';
  return params.slice([...setClause.matchAll(/\?/g)].length);
}

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
    expect(sql).not.toContain('alert_away_minutes');
    expect(sql).not.toContain('alert_idle_minutes');
    expect(params).toEqual([9]);
  });
});

describe('ControlsRepository.findByStudent', () => {
  it('读到行时把 TINYINT 转成布尔、汇率与两个阈值都转成 number', async () => {
    const pool = mockPool({
      rows: [
        {
          points_per_yuan: 25,
          reward_redemption_enabled: 0,
          alert_away_minutes: 3,
          alert_idle_minutes: 20,
          session_lock_minutes: 60,
        },
      ],
    });
    const repo = new ControlsRepository(pool as any);

    const out = await repo.findByStudent(9);

    expect(out).toEqual({
      pointsPerYuan: 25,
      rewardRedemptionEnabled: false,
      alertAwayMinutes: 3,
      alertIdleMinutes: 20,
      sessionLockMinutes: 60,
    });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(selectList(sql)).toEqual([
      'points_per_yuan',
      'reward_redemption_enabled',
      'alert_away_minutes',
      'alert_idle_minutes',
      'session_lock_minutes',
    ]);
    expect(sql).toContain('FROM controls');
    expect(sql).toContain('WHERE student_id = ? LIMIT 1');
    expect(params).toEqual([9]);
  });

  it('无行 / 列为 NULL 时返回默认值（20 分/元、开启、切走 5、无操作 15）；锁定时长唯独给 null 不给 0', async () => {
    const repo = new ControlsRepository(mockPool({ rows: [] }) as any);

    await expect(repo.findByStudent(9)).resolves.toEqual({
      pointsPerYuan: 20,
      rewardRedemptionEnabled: true,
      alertAwayMinutes: 5,
      alertIdleMinutes: 15,
      sessionLockMinutes: null,
    });

    const nullRow = mockPool({
      rows: [
        {
          points_per_yuan: null,
          reward_redemption_enabled: null,
          alert_away_minutes: null,
          alert_idle_minutes: null,
          session_lock_minutes: null,
        },
      ],
    });
    const repo2 = new ControlsRepository(nullRow as any);
    await expect(repo2.findByStudent(9)).resolves.toEqual({
      pointsPerYuan: 20,
      rewardRedemptionEnabled: true,
      alertAwayMinutes: 5,
      alertIdleMinutes: 15,
      sessionLockMinutes: null,
    });
  });
});

describe('ControlsRepository.update', () => {
  const writePool = (affectedRows = 1) => ({
    execute: vi.fn().mockResolvedValue([{ affectedRows }, []]),
  });

  it('两个阈值列写进 SET 且按列名配对，studentId 排在最后', async () => {
    const pool = writePool(1);
    const repo = new ControlsRepository(pool as any);

    expect(await repo.update(9, { alertAwayMinutes: 2, alertIdleMinutes: 5 })).toBe(1);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('UPDATE controls SET');
    expect(zipSet(sql as string, params as unknown[])).toEqual({
      alert_away_minutes: 2,
      alert_idle_minutes: 5,
    });
    expect(restAfterSet(sql as string, params as unknown[])).toEqual([9]);
  });

  it('新旧列混改时列与值仍一一对应（阈值与开关写反会静默改错家长配置）', async () => {
    const pool = writePool(1);
    const repo = new ControlsRepository(pool as any);

    await repo.update(9, { rewardRedemptionEnabled: false, alertAwayMinutes: 2 });

    const [sql, params] = pool.execute.mock.calls[0];
    expect(zipSet(sql as string, params as unknown[])).toEqual({
      reward_redemption_enabled: 0,
      alert_away_minutes: 2,
    });
    expect(restAfterSet(sql as string, params as unknown[])).toEqual([9]);
  });

  it('空 patch → 返回 0 且不发 SQL（no-op，不能把两个阈值当成「清空」）', async () => {
    const pool = writePool(0);
    const repo = new ControlsRepository(pool as any);

    expect(await repo.update(9, {})).toBe(0);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('sessionLockMinutes 写进 SET；`null` 是「清空锁」的合法值，必须真的传下去（不是被 undefined 短路跳过）', async () => {
    const setPool = writePool(1);
    const repo = new ControlsRepository(setPool as any);

    expect(await repo.update(9, { sessionLockMinutes: 60 })).toBe(1);
    {
      const [sql, params] = setPool.execute.mock.calls[0];
      expect(zipSet(sql as string, params as unknown[])).toEqual({ session_lock_minutes: 60 });
      expect(restAfterSet(sql as string, params as unknown[])).toEqual([9]);
    }

    const clearPool = writePool(1);
    const repo2 = new ControlsRepository(clearPool as any);

    expect(await repo2.update(9, { sessionLockMinutes: null })).toBe(1);
    {
      const [sql, params] = clearPool.execute.mock.calls[0];
      // 关键：null 必须出现在 SET 子句并带着 null 参数发出去。
      // 若实现用 `if (patch.sessionLockMinutes)` 判空，这里会退化成空 patch → 不发 SQL、返回 0，
      // 家长点「解除锁定」会静默失败。
      expect(zipSet(sql as string, params as unknown[])).toEqual({ session_lock_minutes: null });
      expect(restAfterSet(sql as string, params as unknown[])).toEqual([9]);
    }
  });
});

describe('ControlsRepository.findAlertThresholds', () => {
  it('只 SELECT 两个阈值列、单条查询（心跳每 30 秒调一次，不顺手读兑换两列）', async () => {
    const pool = {
      execute: vi
        .fn()
        .mockResolvedValue([[{ alert_away_minutes: 2, alert_idle_minutes: 30 }], []]),
    };
    const repo = new ControlsRepository(pool as any);

    expect(await repo.findAlertThresholds(9)).toEqual({ awayMinutes: 2, idleMinutes: 30 });

    expect(pool.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(selectList(sql)).toEqual(['alert_away_minutes', 'alert_idle_minutes']);
    expect(sql).toContain('FROM controls WHERE student_id = ? LIMIT 1');
    expect(sql).not.toContain('points_per_yuan');
    expect(sql).not.toContain('reward_redemption_enabled');
    expect(params).toEqual([9]);
  });

  it('无行 / 列为 NULL → 默认档 { awayMinutes: 5, idleMinutes: 15 }，不返回 null', async () => {
    const emptyPool = { execute: vi.fn().mockResolvedValue([[], []]) };
    await expect(new ControlsRepository(emptyPool as any).findAlertThresholds(9)).resolves.toEqual({
      awayMinutes: 5,
      idleMinutes: 15,
    });

    const nullPool = {
      execute: vi
        .fn()
        .mockResolvedValue([[{ alert_away_minutes: null, alert_idle_minutes: null }], []]),
    };
    await expect(new ControlsRepository(nullPool as any).findAlertThresholds(9)).resolves.toEqual({
      awayMinutes: 5,
      idleMinutes: 15,
    });
  });
});

describe('ControlsRepository.findSessionLockMinutes', () => {
  it('有值 → 数字', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ session_lock_minutes: 60 }], []]) };
    const repo = new ControlsRepository(pool as any);
    expect(await repo.findSessionLockMinutes(9)).toBe(60);
  });

  it('无行 / NULL → null（未设锁，不是 0）', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[], []]) };
    const repo = new ControlsRepository(pool as any);
    expect(await repo.findSessionLockMinutes(9)).toBeNull();

    const nullPool = { execute: vi.fn().mockResolvedValue([[{ session_lock_minutes: null }], []]) };
    const repo2 = new ControlsRepository(nullPool as any);
    expect(await repo2.findSessionLockMinutes(9)).toBeNull();
  });

  it('只发一条 SELECT —— 读路径不建行（不 ensure）', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ session_lock_minutes: 60 }], []]) };
    const repo = new ControlsRepository(pool as any);
    await repo.findSessionLockMinutes(9);

    expect(pool.execute).toHaveBeenCalledTimes(1);
    expect(pool.execute.mock.calls[0][0]).toMatch(/^\s*SELECT .*FROM controls/i);
  });
});
