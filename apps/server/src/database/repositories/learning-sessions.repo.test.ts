import { describe, it, expect, vi } from 'vitest';
import { LearningSessionsRepository } from './learning-sessions.repo.js';

/** 一条 learning_sessions 行的完整形状（列顺序不重要，映射只按字段名取）。 */
const ROW = {
  id: 7,
  student_id: 9,
  app_shell: 'electron',
  started_at: new Date('2026-09-23T01:00:00.000Z'),
  last_seen_at: new Date('2026-09-23T01:00:00.000Z'),
  ended_at: null,
  lock_minutes: 60,
  lock_expires_at: new Date('2026-09-23T02:00:00.000Z'),
  unlocked_at: null,
  unlocked_by_parent_id: null,
};

/** 数一条 SQL 里有几个 `?` 占位符。 */
const placeholderCount = (sql: string) => (sql.match(/\?/g) ?? []).length;

describe('LearningSessionsRepository.insertOpen', () => {
  /**
   * 这条用例是 **2026-09-24 线上事故的回归钉子**：未设锁时曾把 `lock_expires_at` 拼成字面量
   * `NULL`，语句只剩 3 个 `?` 却传了 2 个参数，mysql2 走服务端预处理（参数按位置绑定）
   * 直接报 `Incorrect arguments to COM_STMT_EXECUTE`。**「未设锁」是绝大多数学生的默认态**，
   * 所以这条路径一坏，取或建端点就整个不可用。
   * 断言口径：占位符个数必须 == 参数个数，且 null 要作为**参数**传下去。
   */
  it('未设锁（lockMinutes=null）：占位符数 == 参数数，且 null 走参数而非拼进 SQL', async () => {
    const pool = {
      execute: vi.fn().mockImplementation((sql: string) => {
        if (/^\s*INSERT/i.test(sql)) return Promise.resolve([{ insertId: 7 }, []]);
        return Promise.resolve([[{ ...ROW, lock_minutes: null, lock_expires_at: null }], []]);
      }),
    };
    const repo = new LearningSessionsRepository(pool as any);

    const row = await repo.insertOpen({ studentId: 9, appShell: 'electron', lockMinutes: null });

    const [insertSql, insertParams] = pool.execute.mock.calls[0];
    expect(placeholderCount(insertSql as string)).toBe((insertParams as unknown[]).length);
    expect(placeholderCount(insertSql as string)).toBe(4);
    expect(insertParams).toEqual([9, 'electron', null, null]);
    // 不能把 NULL 当字面量拼进 VALUES（正是事故的写法）
    expect(insertSql as string).not.toMatch(/VALUES\s*\([^)]*NULL/i);
    expect(row.lock_expires_at).toBeNull();
  });

  it('设了锁：第 4 个参数仍走占位符，到期时间由 DB 侧 NOW(3) 算（占位符数仍 == 参数数）', async () => {
    const pool = {
      execute: vi.fn().mockImplementation((sql: string) => {
        if (/^\s*INSERT/i.test(sql)) return Promise.resolve([{ insertId: 7 }, []]);
        return Promise.resolve([[ROW], []]);
      }),
    };
    const repo = new LearningSessionsRepository(pool as any);

    await repo.insertOpen({ studentId: 9, appShell: 'electron', lockMinutes: 60 });

    const [insertSql, insertParams] = pool.execute.mock.calls[0];
    expect(insertSql as string).toContain('DATE_ADD(NOW(3), INTERVAL ? MINUTE)');
    expect(placeholderCount(insertSql as string)).toBe(4);
    expect(insertParams).toEqual([9, 'electron', 60, 60]);
  });

  it('撞唯一键 1062（已有进行中会话）→ 回读既有行返回，不抛错、不重试插入', async () => {
    const existing = { ...ROW, id: 3 };
    const calls: string[] = [];
    const pool = {
      execute: vi.fn().mockImplementation((sql: string) => {
        if (/^\s*INSERT/i.test(sql)) {
          calls.push('INSERT');
          const err = new Error('Duplicate entry') as Error & { errno: number };
          err.errno = 1062;
          return Promise.reject(err);
        }
        calls.push('SELECT');
        return Promise.resolve([[existing], []]);
      }),
    };
    const repo = new LearningSessionsRepository(pool as any);

    const row = await repo.insertOpen({ studentId: 9, appShell: 'electron', lockMinutes: 60 });

    // 返回的是**既有那一行**（id 3），不是新建的 → 「重启不重置时钟」
    expect(row.id).toBe(3);
    expect(calls).toEqual(['INSERT', 'SELECT']);
  });
});

describe('LearningSessionsRepository 其余方法', () => {
  it('findOpen 只取该生进行中的行；无行 → null', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[], []]) };
    const repo = new LearningSessionsRepository(pool as any);

    expect(await repo.findOpen(9)).toBeNull();
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('WHERE student_id = ? AND ended_at IS NULL LIMIT 1');
    expect(params).toEqual([9]);
  });

  it('touch 只刷新进行中行的 last_seen_at（不误改已结束的行）', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    const repo = new LearningSessionsRepository(pool as any);

    await repo.touch(9);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('SET last_seen_at = NOW(3)');
    expect(sql).toContain('WHERE student_id = ? AND ended_at IS NULL');
    expect(params).toEqual([9]);
  });

  it('endOpen 结束进行中会话，谓词同样是 ended_at IS NULL（幂等）', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 0 }, []]) };
    const repo = new LearningSessionsRepository(pool as any);

    await repo.endOpen(9);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('SET ended_at = NOW(3)');
    expect(sql).toContain('WHERE student_id = ? AND ended_at IS NULL');
    expect(params).toEqual([9]);
  });
});
