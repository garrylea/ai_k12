import { describe, it, expect, vi } from 'vitest';
import { SafetyAlertsRepository } from './safety-alerts.repo.js';

/**
 * mockPool 模拟 mysql2 的 pool 双返回形状：[rows, fields]。
 *
 * `execute` 与 `query` **都要 stub**：`listByParent` 的列表查询带 `LIMIT ?`，必须走
 * `query`（客户端转义），COUNT 与其余单行查询走 `execute`。少 stub 一个，调用点会以
 * `pool.<method> is not a function` 直接爆出来——这正是 2026-09-20 那次修复的连带影响
 * （改池方法后旧 mock 只 stub 了 execute）。
 */
const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([[], []]),
  query: vi.fn().mockResolvedValue([[], []]),
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

describe('SafetyAlertsRepository.countOlderThan', () => {
  it('SQL 用 created_at < ?，参数就是传入的 Date（保留期常量不落在仓储里）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: '5', unread: '2' }], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    const cutoff = new Date('2026-08-21T10:00:00Z');
    expect(await repo.countOlderThan(cutoff)).toEqual({ total: 5, unread: 2 });

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM safety_alerts WHERE created_at < ?');
    expect(sql).toContain('SUM(is_read = 0) AS unread');
    // 与 existsRecent 同口径：cutoff 由调用方给，仓储里写 NOW()/CURDATE() 会让保留期不可测
    expect(sql).not.toMatch(/NOW\s*\(|CURDATE\s*\(/i);
    expect(params).toEqual([cutoff]);
  });

  it('0 行时 SUM(...) 回来是 NULL → unread 兜底 0；COUNT 字符串也转 number', async () => {
    const pool = mockPool();
    // 真实 MySQL 空集形状：COUNT 是 '0'、SUM 是 null
    pool.execute.mockResolvedValueOnce([[{ n: '0', unread: null }], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    expect(await repo.countOlderThan(new Date())).toEqual({ total: 0, unread: 0 });
  });

  it('空结果集（无行）→ 全 0，不抛', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    expect(await repo.countOlderThan(new Date())).toEqual({ total: 0, unread: 0 });
  });

  it('未读比总数大也不可能（两个数字各自独立转换，不做减法推导）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: '7', unread: '7' }], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    expect(await repo.countOlderThan(new Date())).toEqual({ total: 7, unread: 7 });
  });
});

describe('SafetyAlertsRepository.deleteOlderThan', () => {
  it('SQL 用 created_at < ?（不是 >，写反就删错一半），返回 affectedRows', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ affectedRows: 3 }, []]);
    const repo = new SafetyAlertsRepository(pool as any);

    const cutoff = new Date('2026-08-21T10:00:00Z');
    expect(await repo.deleteOlderThan(cutoff)).toBe(3);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('DELETE FROM safety_alerts WHERE created_at < ?');
    expect(sql).not.toContain('created_at > ?');
    expect(sql).not.toMatch(/NOW\s*\(|CURDATE\s*\(/i);
    expect(params).toEqual([cutoff]);
  });

  it('没有命中行 → 返回 0（不是 undefined）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    const repo = new SafetyAlertsRepository(pool as any);

    expect(await repo.deleteOlderThan(new Date())).toBe(0);
  });

  it('无 LIMIT（不带 LIMIT ? 才敢走 execute 预处理语句）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new SafetyAlertsRepository(pool as any);

    await repo.deleteOlderThan(new Date());

    const [sql] = pool.execute.mock.calls[0];
    expect(sql).not.toMatch(/LIMIT\s*\?/);
    expect(pool.query).not.toHaveBeenCalled();
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

describe('SafetyAlertsRepository.countUnread', () => {
  it('顶层：只按 parent_id + is_read = 0 计数（不带 student_id、不取行）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: '7' }], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    expect(await repo.countUnread(3)).toBe(7);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toMatch(/^SELECT COUNT\(\*\) AS n FROM safety_alerts WHERE/);
    expect(zipWhere(sql as string, params as unknown[])).toEqual({ parent_id: 3 });
    expect(sql).toContain('is_read = 0');
    expect(sql).not.toContain('student_id = ?');
    expect(sql).not.toContain('LIMIT');
  });

  it('学生级：parent_id 与 student_id 按列名各就各位（写反会数错孩子）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: 3 }], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    expect(await repo.countUnread(3, 11)).toBe(3);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(zipWhere(sql as string, params as unknown[])).toEqual({ parent_id: 3, student_id: 11 });
    expect(restAfterWhere(sql as string, params as unknown[])).toEqual([]);
  });

  it('COUNT 回来是字符串也转成 number；空结果 → 0', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: '2' }], []]);
    expect(await new SafetyAlertsRepository(pool as any).countUnread(3)).toBe(2);

    const empty = mockPool();
    empty.execute.mockResolvedValueOnce([[], []]);
    expect(await new SafetyAlertsRepository(empty as any).countUnread(3)).toBe(0);
  });
});

describe('SafetyAlertsRepository.listByParent', () => {
  it('筛选按列名配对，分页参数排在筛选参数之后（不做位置硬编码）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: '3' }], []]);
    pool.query.mockResolvedValueOnce([
      [{ id: 1, parent_id: 5, student_id: 7, student_name: '小明' }],
      [],
    ]);
    const repo = new SafetyAlertsRepository(pool as any);

    const out = await repo.listByParent(5, { studentId: 7, unreadOnly: true }, 20, 40);

    const [countSql, countParams] = pool.execute.mock.calls[0];
    const [listSql, listParams] = pool.query.mock.calls[0];

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
    pool.query.mockResolvedValueOnce([[{ id: 1 }], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    const out = await repo.listByParent(5, {}, 1, 0);

    // COUNT 走 execute、列表走 query，各一次（列表带 LIMIT ? 不能走预处理语句）
    expect(pool.execute).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledTimes(1);
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
    pool.query.mockResolvedValueOnce([[], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    await repo.listByParent(5, {}, 10, 0);

    // 列表走 query（LIMIT ?）
    const [listSql] = pool.query.mock.calls[0];
    expect(listSql).toContain('SELECT sa.*, s.name AS student_name');
    expect(listSql).toContain('LEFT JOIN students s ON s.id = sa.student_id');
    expect(listSql).toContain('ORDER BY sa.created_at DESC, sa.id DESC');
    expect(listSql).toContain('LIMIT ? OFFSET ?');
  });

  it('不传筛选时不加谓词、不占参数位', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: 0 }], []]);
    pool.query.mockResolvedValueOnce([[], []]);
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
    pool.query.mockResolvedValueOnce([[], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    await repo.listByParent(5, { unreadOnly: false }, 10, 0);

    const [countSql] = pool.execute.mock.calls[0];
    expect(countSql).not.toContain('is_read');
  });

  /**
   * 形态护栏：`LIMIT ?` 必须走 `pool.query`（客户端转义）。
   *
   * 为什么单靠「断言 SQL 字符串」的仓储测试拦不住这类错误：`mockPool` 从不真正执行 SQL，
   * 所以「SQL 长得对、参数顺序也对」与「MySQL 愿意执行它」是两件**结构上不可互相推导**的事。
   * 2026-09-20 实测：`listByParent` 的列表查询用 `pool.execute` 时，真库对
   * `GET /api/parent/alerts` **每调必 500**（`ER_WRONG_ARGUMENTS Incorrect arguments to
   * mysqld_stmt_execute`），而当时全部仓储用例绿。本用例是那条真库现象的**离线替身**：
   * 钉住「带 LIMIT ? 的语句只准走 query」。同款钉子见 `parent-insights.repo.test.ts:349`、
   * `point-ledger.repo.test.ts:151-157`。
   */
  it('形态护栏：列表 SQL 含 LIMIT ? → 走 query，且 execute 一条含 LIMIT ? 的 SQL 都没收到', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: 0 }], []]);
    pool.query.mockResolvedValueOnce([[], []]);
    const repo = new SafetyAlertsRepository(pool as any);

    await repo.listByParent(5, {}, 20, 0);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toContain('LIMIT ? OFFSET ?');
    // 反向断言：execute 收到的任何 SQL 都不得含 LIMIT ?（改回 execute 时这一条与上一条同时红）
    for (const [sql] of pool.execute.mock.calls) {
      expect(String(sql)).not.toMatch(/LIMIT\s*\?/);
    }
  });
});
