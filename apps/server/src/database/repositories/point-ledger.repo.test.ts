import { describe, it, expect, vi } from 'vitest';
import { PointLedgerRepository } from './point-ledger.repo';

/**
 * 模拟 mysql2 pool 的双返回形状：
 * - INSERT/UPDATE -> [ResultSetHeader, fields]
 * - SELECT        -> [rows[], fields]
 */
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

const insertRow = () => ({
  student_id: 9,
  kind: 'earn' as const,
  task_code: 'en_vocabulary',
  tier_key: '10',
  points: 2,
  dedupe_key: 'vsess:41',
  title: '英语背单词 · 10 词',
  ref_type: 'training_session' as string | null,
  ref_id: 41 as number | null,
});

describe('PointLedgerRepository.insert', () => {
  it('INSERT IGNORE 落一条流水，返回 { id, duplicate:false }', async () => {
    const pool = mockPool({ insertId: 77, affectedRows: 1 });
    const repo = new PointLedgerRepository(pool as any);
    const out = await repo.insert(insertRow());
    expect(out).toEqual({ id: 77, duplicate: false });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT IGNORE INTO point_ledger');
    expect(sql).toContain('(student_id, kind, task_code, tier_key, points, dedupe_key, title, ref_type, ref_id, redemption_id)');
    expect(params).toEqual([9, 'earn', 'en_vocabulary', '10', 2, 'vsess:41', '英语背单词 · 10 词', 'training_session', 41, null]);
  });

  it('撞 uniq_point_ledger_dedupe（affectedRows=0）→ duplicate:true', async () => {
    // 此时 insertId 不是既有行的 id（MySQL 的 INSERT IGNORE 在重复键时 insertId 语义不可依赖），
    // 调用方必须用 findByDedupeKey 回查首次结果，不能拿 insertId 当既有流水 id。
    const pool = mockPool({ insertId: 0, affectedRows: 0 });
    const repo = new PointLedgerRepository(pool as any);
    const out = await repo.insert(insertRow());
    expect(out).toEqual({ id: 0, duplicate: true });
    expect(pool.execute).toHaveBeenCalledTimes(1);
  });

  it('传 conn 时走 conn.execute（发分引擎要流水与快照同事务）', async () => {
    const pool = mockPool();
    const repo = new PointLedgerRepository(pool as any);
    const conn = { execute: vi.fn().mockResolvedValue([{ insertId: 88, affectedRows: 1 }, []]) };
    const out = await repo.insert(insertRow(), conn as any);
    expect(out).toEqual({ id: 88, duplicate: false });
    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('tier_key 缺省时写 default，可空字段缺省写 null', async () => {
    const pool = mockPool();
    const repo = new PointLedgerRepository(pool as any);
    await repo.insert({
      student_id: 9,
      kind: 'redeem',
      task_code: 'redeem',
      points: -100,
      dedupe_key: 'redeem:5',
      title: '兑换 · 现金 5 元',
    });
    const [, params] = pool.execute.mock.calls[0];
    expect(params).toEqual([9, 'redeem', 'redeem', 'default', -100, 'redeem:5', '兑换 · 现金 5 元', null, null, null]);
  });
});

describe('PointLedgerRepository.findByDedupeKey', () => {
  it('按 dedupe_key 回查首次流水', async () => {
    const row = { id: 1, dedupe_key: 'vsess:41', points: 2 };
    const pool = mockPool({ rows: [row] });
    const repo = new PointLedgerRepository(pool as any);
    expect(await repo.findByDedupeKey('vsess:41')).toEqual(row);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('WHERE dedupe_key = ?');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual(['vsess:41']);

    const repoEmpty = new PointLedgerRepository(mockPool({ rows: [] }) as any);
    expect(await repoEmpty.findByDedupeKey('nope')).toBeNull();
  });
});

describe('PointLedgerRepository.countTodayEarned', () => {
  it('只数 kind=earn，两个日界由应用层传参（SQL 不含 CURDATE）', async () => {
    const pool = mockPool({ rows: [{ count: 2 }] });
    const repo = new PointLedgerRepository(pool as any);
    const dayStart = new Date('2026-09-17T00:00:00+08:00');
    const dayEnd = new Date('2026-09-18T00:00:00+08:00');
    expect(await repo.countTodayEarned(9, 'en_vocabulary', dayStart, dayEnd)).toBe(2);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain("kind = 'earn'");
    expect(sql).toContain('created_at >= ? AND created_at < ?');
    // 钉住仓内约定：DB 会话时区可能与应用不一致，日界必须在 Node 算好传参
    expect(sql).not.toContain('CURDATE');
    expect(sql).not.toContain('NOW()');
    expect(params).toEqual([9, 'en_vocabulary', dayStart, dayEnd]);
  });

  it('无行时返回 0 而不是 NaN', async () => {
    const repo = new PointLedgerRepository(mockPool({ rows: [] }) as any);
    expect(await repo.countTodayEarned(9, 'en_vocabulary', new Date(), new Date())).toBe(0);
  });
});

describe('PointLedgerRepository 求和（重建脚本用）', () => {
  it('sumEarned 只累加 kind=earn，sumAll 累加全部', async () => {
    const pool = mockPool({ rows: [{ total: 12 }] });
    const repo = new PointLedgerRepository(pool as any);
    expect(await repo.sumEarned(9)).toBe(12);
    let [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('COALESCE(SUM(points), 0)');
    expect(sql).toContain("kind = 'earn'");
    expect(params).toEqual([9]);

    expect(await repo.sumAll(9)).toBe(12);
    [sql, params] = pool.execute.mock.calls[1];
    expect(sql).toContain('COALESCE(SUM(points), 0)');
    expect(sql).not.toContain("kind = 'earn'");
    expect(params).toEqual([9]);
  });

  it('无流水时返回 0', async () => {
    const repo = new PointLedgerRepository(mockPool({ rows: [] }) as any);
    expect(await repo.sumEarned(9)).toBe(0);
  });
});

describe('PointLedgerRepository.listByStudent', () => {
  it('按 id 倒序分页；LIMIT ? 走 pool.query 绕开 prepared statement', async () => {
    const rows = [{ id: 3 }, { id: 2 }];
    const pool = mockPool({ rows });
    const repo = new PointLedgerRepository(pool as any);
    expect(await repo.listByStudent(9, 2, 0)).toEqual(rows);

    // MySQL 对预处理语句的 LIMIT ? 报 Incorrect arguments，必须走 query
    expect(pool.execute).not.toHaveBeenCalled();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('FROM point_ledger');
    expect(sql).toContain('WHERE student_id = ?');
    expect(sql).toContain('ORDER BY id DESC');
    expect(sql).toContain('LIMIT ? OFFSET ?');
    expect(params).toEqual([9, 2, 0]);
  });
});

describe('PointLedgerRepository.countByStudent', () => {
  it('返回该生流水条数（分页 total）', async () => {
    const pool = mockPool({ rows: [{ count: 5 }] });
    const repo = new PointLedgerRepository(pool as any);
    expect(await repo.countByStudent(9)).toBe(5);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain('WHERE student_id = ?');
    expect(params).toEqual([9]);
  });
});
