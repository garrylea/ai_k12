import { describe, it, expect, vi } from 'vitest';
import { AuthSessionsRepository } from './auth-sessions.repo.js';

const mkPool = () => {
  // 单一连接：upsert 与 SELECT LAST_INSERT_ID() 必须跑在同一个 connection 上，
  // 否则 LAST_INSERT_ID() 跨连接不存活（终审 Important：并发交错可同 seq 双活）。
  const connExecute = vi.fn()
    .mockResolvedValueOnce([{ affectedRows: 1 }, undefined])          // INSERT..ON DUP
    .mockResolvedValueOnce([[{ seq: 3 }], undefined]);                // SELECT LAST_INSERT_ID()
  const release = vi.fn();
  const conn = { execute: connExecute, release };
  const getConnection = vi.fn().mockResolvedValue(conn);
  return { pool: { getConnection } as any, conn, connExecute, release, getConnection };
};

describe('AuthSessionsRepository', () => {
  it('bumpAndReturnSeq：取一条连接，upsert（LAST_INSERT_ID(seq+1)）与 LAST_INSERT_ID() 回读同连接，最后 release', async () => {
    const { pool, conn, connExecute, release, getConnection } = mkPool();
    const repo = new AuthSessionsRepository(pool);

    await expect(repo.bumpAndReturnSeq('student', 7)).resolves.toBe(3);

    expect(getConnection).toHaveBeenCalledTimes(1);
    // 两条语句都跑在同一连接对象上（不是 pool.execute）
    expect(connExecute).toHaveBeenCalledTimes(2);

    const [sql1, params1] = connExecute.mock.calls[0] as [string, unknown[]];
    expect(sql1).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql1).toContain('LAST_INSERT_ID(token_seq + 1)');
    expect(params1).toEqual(['student', 7]);

    const [sql2, params2] = connExecute.mock.calls[1] as [string, unknown[]];
    expect(sql2).toContain('LAST_INSERT_ID()');
    expect(params2).toEqual(['student', 7]);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('bumpAndReturnSeq：upsert 成功但回读为空 → 抛错（fail loud，不再静默回退 seq=1）', async () => {
    const connExecute = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }, undefined])
      .mockResolvedValueOnce([[], undefined]);
    const release = vi.fn();
    const pool = { getConnection: vi.fn().mockResolvedValue({ execute: connExecute, release }) } as any;
    const repo = new AuthSessionsRepository(pool);

    await expect(repo.bumpAndReturnSeq('student', 7)).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('bumpAndReturnSeq：upsert 抛错 → release 仍被调用（finally），异常向上传播', async () => {
    const connExecute = vi.fn().mockRejectedValue(new Error('db down'));
    const release = vi.fn();
    const pool = { getConnection: vi.fn().mockResolvedValue({ execute: connExecute, release }) } as any;
    const repo = new AuthSessionsRepository(pool);

    await expect(repo.bumpAndReturnSeq('student', 7)).rejects.toThrow('db down');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('listAll：返回整表行', async () => {
    const execute = vi.fn().mockResolvedValue([
      [{ role: 'student', user_id: 7, token_seq: 3 }],
      undefined,
    ]);
    const repo = new AuthSessionsRepository({ execute } as any);

    await expect(repo.listAll()).resolves.toEqual([
      { role: 'student', user_id: 7, token_seq: 3 },
    ]);
    const [sql] = execute.mock.calls[0] as [string];
    expect(sql).not.toContain('WHERE'); // 全量，无过滤
  });
});
