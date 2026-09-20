import { describe, it, expect, vi } from 'vitest';
import { SafetyAlertsRepository } from './safety-alerts.repo.js';

const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([[], []]),
});

/**
 * 把 WHERE 子句里的 `列 = ?` 谓词与参数**按列名配对**成对象。
 *
 * 为什么不直接断言 params 数组字面量：那只能证明「代码与它自己一致」。`listByParent` 的
 * params 是「parentId + 可选筛选 + 分页」拼出来的，一旦 `parent_id` 与 `student_id` 的顺序
 * 写反（`goals.repo.test.ts:12-17` 记的那类列错位），位置断言照样全绿，但筛选条件会张冠李戴。
 * 按列名配对才能拦住这一类错误。
 */
function zipWhere(sql: string, params: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let pi = 0;
  for (const m of sql.matchAll(/(\w+(?:\.\w+)?)\s*=\s*\?/g)) {
    out[m[1]] = params[pi++];
  }
  return out;
}

/** 谓词吃掉之后剩下的参数（`listByParent` 里就是 LIMIT / OFFSET）。 */
function restAfterWhere(sql: string, params: unknown[]): unknown[] {
  return params.slice(sql.match(/(\w+(?:\.\w+)?)\s*=\s*\?/g)?.length ?? 0);
}

describe('SafetyAlertsRepository.existsRecent', () => {
  it('SQL 用 created_at >= ?，第三个参数是应用层算好的 Date（仓储不写业务窗口）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: 0 }], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    const since = new Date('2026-09-20T10:00:00Z');
    expect(await repo.existsRecent(9, 'away', since)).toBe(false);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('student_id = ? AND type = ?');
    expect(sql).toContain('created_at >= ?');
    // 窗口必须由调用方给：仓储里写 NOW()/CURDATE() 会让 30 分钟窗口变成「不可测的隐式行为」
    expect(sql).not.toMatch(/NOW\s*\(|CURDATE\s*\(/i);
    expect(params).toHaveLength(3);
    expect(params[0]).toBe(9);
    expect(params[1]).toBe('away');
    expect(params[2]).toBeInstanceOf(Date);
    expect(params[2]).toBe(since);
  });

  it('COUNT 回来是字符串（mysql2 的 COUNT 类型）也判成 true', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: '2' }], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    expect(await repo.existsRecent(9, 'idle', new Date())).toBe(true);
  });

  it('无行（空结果集）→ false，不抛', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    expect(await repo.existsRecent(9, 'idle', new Date())).toBe(false);
  });
});

describe('SafetyAlertsRepository.findById', () => {
  it('命中 → 返回该行', async () => {
    const pool = mockPool();
    const row = { id: 3, parent_id: 5, student_id: 9, type: 'off_topic', is_read: 0 };
    pool.execute.mockResolvedValueOnce([[row], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    expect(await repo.findById(3)).toEqual(row);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM safety_alerts WHERE id = ?');
    expect(params).toEqual([3]);
  });

  it('未命中 → null（不是 undefined）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    expect(await repo.findById(404)).toBeNull();
  });
});

describe('SafetyAlertsRepository.listByParent', () => {
  it('筛选按列名配对，分页参数排在筛选参数之后（不做位置硬编码）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: '3' }], []]);
    pool.execute.mockResolvedValueOnce([
      [{ id: 1, parent_id: 5, student_id: 7, student_name: '小明' }],
      [],
    ]);
    const repo = new SafetyAlertsRepository(pool as any);

    const out = await repo.listByParent(5, { studentId: 7, unreadOnly: true }, 20, 40);

    const [countSql, countParams] = pool.execute.mock.calls[0];
    const [listSql, listParams] = pool.execute.mock.calls[1];

    expect(zipWhere(countSql as string, countParams as unknown[])).toEqual({
      'sa.parent_id': 5,
      'sa.student_id': 7,
    });
    expect(zipWhere(listSql as string, listParams as unknown[])).toEqual({
      'sa.parent_id': 5,
      'sa.student_id': 7,
    });
    // 分页参数是 WHERE 谓词之后的那两个，别插到筛选参数中间
    expect(restAfterWhere(listSql as string, listParams as unknown[])).toEqual([20, 40]);
    expect(out.total).toBe(3);
    expect(out.items[0].student_name).toBe('小明');
  });

  it('total 来自独立 COUNT 查询（不受 LIMIT 影响），不是 items.length', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: '42' }], []]);
    pool.execute.mockResolvedValueOnce([[{ id: 1 }], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    const out = await repo.listByParent(5, {}, 1, 0);

    expect(pool.execute).toHaveBeenCalledTimes(2);
    const [countSql, countParams] = pool.execute.mock.calls[0];
    expect(countSql).toMatch(/^SELECT COUNT\(\*\) AS n FROM safety_alerts sa WHERE/);
    expect(countSql).not.toContain('LIMIT');
    expect(countParams).toEqual([5]);
    expect(out.total).toBe(42);
    expect(out.items).toHaveLength(1);
  });

  it('孩子名来自 LEFT JOIN students，排序稳定（created_at DESC, id DESC）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: 0 }], []]);
    pool.execute.mockResolvedValueOnce([[], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    await repo.listByParent(5, {}, 10, 0);

    const [listSql] = pool.execute.mock.calls[1];
    expect(listSql).toContain('SELECT sa.*, s.name AS student_name');
    expect(listSql).toContain('LEFT JOIN students s ON s.id = sa.student_id');
    expect(listSql).toContain('ORDER BY sa.created_at DESC, sa.id DESC');
    expect(listSql).toContain('LIMIT ? OFFSET ?');
  });

  it('不传筛选时不加谓词、不占参数位', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: 0 }], []]);
    pool.execute.mockResolvedValueOnce([[], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    await repo.listByParent(5, {}, 10, 0);

    const [countSql, countParams] = pool.execute.mock.calls[0];
    expect(countParams).toEqual([5]);
    expect(countSql).not.toContain('student_id = ?');
    expect(countSql).not.toContain('is_read');
  });

  it('unreadOnly=false 与缺省等价（不加 is_read 谓词）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: 0 }], []]);
    pool.execute.mockResolvedValueOnce([[], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    await repo.listByParent(5, { unreadOnly: false }, 10, 0);

    const [countSql] = pool.execute.mock.calls[0];
    expect(countSql).not.toContain('is_read');
  });
});
