import { describe, expect, it, vi } from 'vitest';
import { AdminsRepository } from './admins.repo.js';

/**
 * 教研员账号管理（2026-11-19）的仓储守卫：**任何 SQL 都必须带 `role='researcher'`**，
 * 否则管理台可能列出或改到 admin 行（越权）。这里只钉 SQL 形状，不连库。
 */
function mkPool(result: any = { insertId: 9 }) {
  return {
    execute: vi.fn().mockImplementation((sql: string) => {
      if (/SELECT/i.test(sql)) {
        return Promise.resolve([[{ id: 5, username: 'r1', name: '教研甲', is_active: 1, created_at: new Date('2026-11-19T00:00:00Z') }], []]);
      }
      return Promise.resolve([result, []]);
    }),
  };
}

describe('AdminsRepository 教研员', () => {
  it('listResearchers 角色硬过滤 + 模糊搜索 + id DESC', async () => {
    const pool = mkPool();
    const repo = new AdminsRepository(pool as any);

    const list = await repo.listResearchers('jia');

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain("role = 'researcher'");
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toContain('ORDER BY id DESC LIMIT 50');
    expect(params).toEqual(['%jia%', '%jia%']);
    expect(list).toEqual([
      { id: 5, username: 'r1', name: '教研甲', isActive: true, createdAt: new Date('2026-11-19T00:00:00Z') },
    ]);
  });

  it('createResearcher 角色在 SQL 里写死 researcher', async () => {
    const pool = mkPool({ insertId: 11 });
    const repo = new AdminsRepository(pool as any);

    await expect(repo.createResearcher({ username: 'r2', passwordHash: 'h', name: null })).resolves.toBe(11);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO admins/i);
    expect(sql).toContain("'researcher'");
    expect(params).toEqual(['r2', 'h', null]);
  });

  it('setActive 更新语句同样带 role 守卫', async () => {
    const pool = mkPool();
    const repo = new AdminsRepository(pool as any);

    await repo.setActive(7, false);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toMatch(/UPDATE admins/i);
    expect(sql).toContain("role = 'researcher'");
    expect(params).toEqual([0, 7]);
  });
});
