import { describe, it, expect, vi } from 'vitest';
import { AuthSessionsRepository } from './auth-sessions.repo.js';

const mkPool = () => {
  const execute = vi.fn()
    .mockResolvedValueOnce([{ affectedRows: 1 }, undefined])          // INSERT..ON DUP
    .mockResolvedValueOnce([[{ token_seq: 3 }], undefined]);          // SELECT 回读
  return { pool: { execute } as any, execute };
};

describe('AuthSessionsRepository', () => {
  it('bumpAndReturnSeq：先 upsert（无行插 1 / 有行 +1），再回读 seq', async () => {
    const { pool, execute } = mkPool();
    const repo = new AuthSessionsRepository(pool);

    await expect(repo.bumpAndReturnSeq('student', 7)).resolves.toBe(3);

    const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('token_seq = token_seq + 1');
    expect(params).toEqual(['student', 7]);
    expect(execute.mock.calls[1]![1]).toEqual(['student', 7]);
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
