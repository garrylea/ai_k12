import { describe, expect, it, vi } from 'vitest';
import { AdminsRepository } from './admins.repo.js';

/**
 * 教研员账号管理（2026-11-19）的仓储守卫：**任何 SQL 都必须带 `role='researcher'`**，
 * 否则管理台可能列出或改到 admin 行（越权）。这里只钉 SQL 形状，不连库。
 */
function mkPool(result: any = { insertId: 9 }) {
  return {
    execute: vi.fn().mockImplementation((sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) return Promise.resolve([[{ total: 60 }], []]);
      if (/SELECT/i.test(sql)) {
        return Promise.resolve([[{ id: 5, username: 'r1', name: '教研甲', is_active: 1, created_at: new Date('2026-11-19T00:00:00Z') }], []]);
      }
      return Promise.resolve([result, []]);
    }),
  };
}

describe('AdminsRepository 教研员', () => {
  it('listResearchers 角色硬过滤 + 模糊搜索 + id DESC，total 走 COUNT', async () => {
    const pool = mkPool();
    const repo = new AdminsRepository(pool as any);

    const out = await repo.listResearchers('jia');

    expect(pool.execute).toHaveBeenCalledTimes(2);
    const [listSql, listParams] = pool.execute.mock.calls[0];
    expect(listSql).toContain("role = 'researcher'");
    expect(listSql).toContain('deleted_at IS NULL');
    expect(listSql).toContain('ORDER BY id DESC LIMIT 50');
    expect(listParams).toEqual(['%jia%', '%jia%']);

    const [countSql, countParams] = pool.execute.mock.calls[1];
    expect(countSql).toContain('COUNT(*) AS total');
    expect(countSql).toContain("role = 'researcher'");
    expect(countParams).toEqual(['%jia%', '%jia%']);

    expect(out.total).toBe(60);
    expect(out.items).toEqual([
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

  it('updateResearcherPassword 带 role 守卫；updatePassword（自助改密）保持不限角色', async () => {
    const pool = mkPool();
    const repo = new AdminsRepository(pool as any);

    await repo.updateResearcherPassword(7, 'h');
    const [staffSql, staffParams] = pool.execute.mock.calls[0];
    expect(staffSql).toMatch(/UPDATE admins/i);
    expect(staffSql).toContain("role = 'researcher'");
    expect(staffParams).toEqual(['h', 7]);

    await repo.updatePassword(7, 'h');
    const [selfSql] = pool.execute.mock.calls[1];
    expect(selfSql).not.toContain("role = 'researcher'");
  });
});
