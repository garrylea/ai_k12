import { describe, it, expect, vi } from 'vitest';
import { PointRulesRepository } from './point-rules.repo';
import type { DefaultRule } from '../../modules/points/default-rules.js';

/**
 * 模拟 mysql2 pool.execute 的双返回形状：
 * - INSERT/UPDATE -> [ResultSetHeader, fields]
 * - SELECT        -> [rows[], fields]
 */
const mockPool = (opts: { rows?: any[]; affectedRows?: number; changedRows?: number; insertId?: number } = {}) => {
  const { rows = [], affectedRows = 1, changedRows = affectedRows, insertId = 7 } = opts;
  return {
    execute: vi.fn().mockImplementation((sql: string) => {
      if (/^\s*INSERT/i.test(sql)) return Promise.resolve([{ insertId, affectedRows }, []]);
      if (/^\s*UPDATE/i.test(sql)) return Promise.resolve([{ affectedRows, changedRows }, []]);
      return Promise.resolve([rows, []]);
    }),
    query: vi.fn().mockResolvedValue([rows, []]),
  };
};

const rule = (over: Partial<DefaultRule> = {}): DefaultRule => ({
  taskCode: 'math_targeted',
  taskName: '数学专项',
  tierKey: '3',
  tierLabel: '3 题',
  points: 8,
  dailyLimit: null,
  sortOrder: 31,
  ...over,
});

describe('PointRulesRepository.findByStudent', () => {
  it('按 sort_order 排序返回该生全部规则', async () => {
    const rows = [{ id: 1, student_id: 10, task_code: 'math_targeted', tier_key: '3' }];
    const pool = mockPool({ rows });
    const repo = new PointRulesRepository(pool as any);
    const out = await repo.findByStudent(10);
    expect(out).toEqual(rows);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM point_rules');
    expect(sql).toContain('WHERE student_id = ?');
    expect(sql).toContain('ORDER BY sort_order');
    expect(params).toEqual([10]);
  });
});

describe('PointRulesRepository.insertIgnoreBatch', () => {
  it('一条多行 INSERT IGNORE，参数按 rules 顺序展平（daily_limit 为 null 也原样绑定）', async () => {
    const pool = mockPool();
    const repo = new PointRulesRepository(pool as any);
    const rules = [
      rule({ tierKey: '1', tierLabel: '1 题', points: 2, sortOrder: 30 }),
      rule({ tierKey: '3', tierLabel: '3 题', points: 8, dailyLimit: 2, sortOrder: 31 }),
    ];
    await repo.insertIgnoreBatch(10, rules);

    // 多条 rule 必须合成一条 SQL（而不是循环单插）
    expect(pool.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT IGNORE INTO point_rules');
    expect(sql).toContain('(student_id, task_code, tier_key, tier_label, points, daily_limit, sort_order)');
    // 两行占位符
    expect(sql.match(/\(\?, \?, \?, \?, \?, \?, \?\)/g)).toHaveLength(2);
    expect(params).toEqual([
      10, 'math_targeted', '1', '1 题', 2, null, 30,
      10, 'math_targeted', '3', '3 题', 8, 2, 31,
    ]);
  });

  it('空数组不发 SQL（避免生成 VALUES 空的非法 INSERT）', async () => {
    const pool = mockPool();
    const repo = new PointRulesRepository(pool as any);
    await repo.insertIgnoreBatch(10, []);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('传入 conn 时走 conn.execute，供调用方在同一事务里跑', async () => {
    const pool = mockPool();
    const repo = new PointRulesRepository(pool as any);
    const conn = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    await repo.insertIgnoreBatch(10, [rule()], conn as any);
    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

describe('PointRulesRepository.updateOne', () => {
  it('生成 SET 子句并返回 affectedRows（值没变、changedRows=0 时仍是 1）', async () => {
    // mysql2 默认 CLIENT_FOUND_ROWS：affectedRows 是**匹配**行数、changedRows 才是改动行数。
    // 家长原样重存同样的值 → changedRows=0 而 affectedRows=1。若实现改成读 changedRows，
    // 服务层会把一个真实存在的档位误判成 3005「档位不存在」——这条直接钉住读的是 affectedRows。
    const pool = mockPool({ affectedRows: 1, changedRows: 0 });
    const repo = new PointRulesRepository(pool as any);
    const affected = await repo.updateOne(10, 'math_targeted', '3', { points: 9, dailyLimit: 5, isActive: true });
    expect(affected).toBe(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('UPDATE point_rules SET');
    expect(sql).toContain('points = ?');
    expect(sql).toContain('daily_limit = ?');
    expect(sql).toContain('is_active = ?');
    expect(sql).toContain('WHERE student_id = ? AND task_code = ? AND tier_key = ?');
    expect(params).toEqual([9, 5, 1, 10, 'math_targeted', '3']);
  });

  it('affectedRows=0 交给调用方判定「该档位不存在」', async () => {
    const pool = mockPool({ affectedRows: 0 });
    const repo = new PointRulesRepository(pool as any);
    expect(await repo.updateOne(10, 'math_targeted', '7', { points: 1 })).toBe(0);
  });

  it('isActive=false 写 0（不是布尔值）；dailyLimit 可为 null', async () => {
    const pool = mockPool();
    const repo = new PointRulesRepository(pool as any);
    await repo.updateOne(10, 'cn_dictation', 'poem', { dailyLimit: null, isActive: false });
    const [, params] = pool.execute.mock.calls[0];
    expect(params).toEqual([null, 0, 10, 'cn_dictation', 'poem']);
  });

  it('未提供任何字段时不发 SQL 并返回 0', async () => {
    const pool = mockPool();
    const repo = new PointRulesRepository(pool as any);
    expect(await repo.updateOne(10, 'math_targeted', '3', {})).toBe(0);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('传入 conn 时走 conn.execute，供家长批量保存在同一事务里跑', async () => {
    const pool = mockPool();
    const repo = new PointRulesRepository(pool as any);
    const conn = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };

    expect(await repo.updateOne(10, 'math_targeted', '3', { points: 9 }, conn as any)).toBe(1);

    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

describe('PointRulesRepository.findOne', () => {
  it('返回首行，无则 null', async () => {
    const row = { id: 5, student_id: 10, task_code: 'en_vocabulary', tier_key: '10' };
    const pool = mockPool({ rows: [row] });
    const repo = new PointRulesRepository(pool as any);
    expect(await repo.findOne(10, 'en_vocabulary', '10')).toEqual(row);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('WHERE student_id = ? AND task_code = ? AND tier_key = ?');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual([10, 'en_vocabulary', '10']);

    const repoEmpty = new PointRulesRepository(mockPool({ rows: [] }) as any);
    expect(await repoEmpty.findOne(10, 'en_vocabulary', '10')).toBeNull();
  });
});
