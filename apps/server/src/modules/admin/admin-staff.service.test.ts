import { describe, expect, it, vi } from 'vitest';
import * as bcrypt from 'bcrypt';
import { AdminStaffService } from './admin-staff.service.js';

function mk(over: { researcher?: any } = {}) {
  const researcher = over.researcher === undefined
    ? { id: 7, username: 'r1', passwordHash: 'old', name: '教研甲', isActive: true, role: 'researcher' }
    : over.researcher;
  return {
    adminsRepo: {
      listResearchers: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      findByUsername: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(researcher),
      createResearcher: vi.fn().mockResolvedValue(11),
      setActive: vi.fn().mockResolvedValue(undefined),
      updateResearcherPassword: vi.fn().mockResolvedValue(undefined),
    },
    authSessionsRepo: { bumpAndReturnSeq: vi.fn().mockResolvedValue(4) },
    sessionRegistry: { bump: vi.fn() },
  };
}

const svc = (d: ReturnType<typeof mk>) =>
  new AdminStaffService(d.adminsRepo as any, d.authSessionsRepo as any, d.sessionRegistry as any);

describe('AdminStaffService.list', () => {
  it('原样返回列表项与 total，不泄漏 passwordHash', async () => {
    const d = mk();
    d.adminsRepo.listResearchers.mockResolvedValue({
      items: [
        { id: 7, username: 'r1', name: '教研甲', isActive: true, createdAt: new Date('2026-11-19T00:00:00Z'), passwordHash: 'secret' },
      ],
      total: 60,
    });
    const out = await svc(d).list('jia');
    expect(d.adminsRepo.listResearchers).toHaveBeenCalledWith('jia');
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(out.items[0]).toMatchObject({ id: 7, username: 'r1', isActive: true });
    // total 是过滤后的总数（可能 > 实际返回的 50 条），供前端提示
    expect(out.total).toBe(60);
  });
});

describe('AdminStaffService.create', () => {
  it('bcrypt 落库（不存明文），角色由 repo 固定 researcher', async () => {
    const d = mk();
    const out = await svc(d).create({ username: 'r22', name: '教研乙', password: 'pass123' });

    expect(out).toEqual({ id: 11, username: 'r22', name: '教研乙', isActive: true });
    const arg = d.adminsRepo.createResearcher.mock.calls[0][0];
    expect(arg.username).toBe('r22');
    expect(arg.passwordHash).not.toBe('pass123');
    await expect(bcrypt.compare('pass123', arg.passwordHash)).resolves.toBe(true);
  });

  it('name 缺省/空白落 null（不写空串）', async () => {
    for (const name of [undefined, '   ']) {
      const d = mk();
      await svc(d).create({ username: 'r22', name, password: 'pass123' });
      expect(d.adminsRepo.createResearcher.mock.calls[0][0].name).toBeNull();
    }
  });

  it('服务层最后防线：非法用户名/密码 → 400/1001，不查重不写库', async () => {
    const bads = [
      { username: 'ab', password: 'pass123' },
      { username: 'bad-name', password: 'pass123' },
      { username: 'r22', password: '12345' },
      { username: 'r22', password: 'a'.repeat(73) },
    ];
    for (const input of bads) {
      const d = mk();
      await expect(svc(d).create(input))
        .rejects.toMatchObject({ status: 400, response: { code: 1001 } });
      expect(d.adminsRepo.findByUsername).not.toHaveBeenCalled();
      expect(d.adminsRepo.createResearcher).not.toHaveBeenCalled();
    }
  });

  it('用户名与已有账号（含 admin）重名 → 409/1004，且不写库', async () => {
    const d = mk();
    d.adminsRepo.findByUsername.mockResolvedValue({ id: 1, username: 'root', role: 'admin' });

    await expect(svc(d).create({ username: 'root', password: 'pass123' }))
      .rejects.toMatchObject({ status: 409, response: { code: 1004 } });
    expect(d.adminsRepo.createResearcher).not.toHaveBeenCalled();
  });
});

describe('AdminStaffService.setStatus', () => {
  it('停用：is_active=0 + bump seq + registry（旧 token 立即 1013）', async () => {
    const d = mk();
    await svc(d).setStatus(7, false);

    expect(d.adminsRepo.setActive).toHaveBeenCalledWith(7, false);
    expect(d.authSessionsRepo.bumpAndReturnSeq).toHaveBeenCalledWith('researcher', 7);
    expect(d.sessionRegistry.bump).toHaveBeenCalledWith('researcher', 7, 4);
  });

  it('停用顺序：bump + registry 必须先于 setActive（fail-closed 钉子）', async () => {
    const d = mk();
    await svc(d).setStatus(7, false);

    const bumpAt = d.authSessionsRepo.bumpAndReturnSeq.mock.invocationCallOrder[0];
    const registryAt = d.sessionRegistry.bump.mock.invocationCallOrder[0];
    const disableAt = d.adminsRepo.setActive.mock.invocationCallOrder[0];
    expect(bumpAt).toBeLessThan(disableAt);
    expect(registryAt).toBeLessThan(disableAt);
  });

  it('bump 失败时不得先停用：账号仍启用（fail-closed，重试可收敛）', async () => {
    const d = mk();
    d.authSessionsRepo.bumpAndReturnSeq.mockRejectedValue(new Error('db down'));

    await expect(svc(d).setStatus(7, false)).rejects.toThrow('db down');
    expect(d.adminsRepo.setActive).not.toHaveBeenCalled();
  });

  it('启用：只置 is_active=1，不 bump（无需踢）', async () => {
    const d = mk();
    await svc(d).setStatus(7, true);

    expect(d.adminsRepo.setActive).toHaveBeenCalledWith(7, true);
    expect(d.authSessionsRepo.bumpAndReturnSeq).not.toHaveBeenCalled();
    expect(d.sessionRegistry.bump).not.toHaveBeenCalled();
  });

  it('目标不是教研员（admin 行 / 不存在）→ 404/1002，不写不改', async () => {
    for (const researcher of [{ id: 1, role: 'admin' }, null]) {
      const d = mk({ researcher });
      await expect(svc(d).setStatus(1, false))
        .rejects.toMatchObject({ status: 404, response: { code: 1002 } });
      expect(d.adminsRepo.setActive).not.toHaveBeenCalled();
      expect(d.authSessionsRepo.bumpAndReturnSeq).not.toHaveBeenCalled();
    }
  });
});

describe('AdminStaffService.resetPassword', () => {
  it('bcrypt 写入 password_hash（走带 role 守卫的 updateResearcherPassword）', async () => {
    const d = mk();
    await svc(d).resetPassword(7, 'newpass1');

    const [id, hash] = d.adminsRepo.updateResearcherPassword.mock.calls[0];
    expect(id).toBe(7);
    expect(hash).not.toBe('newpass1');
    await expect(bcrypt.compare('newpass1', hash)).resolves.toBe(true);
  });

  it('服务层最后防线：密码越界 → 400/1001，不查目标不写密码', async () => {
    for (const password of ['12345', 'a'.repeat(73)]) {
      const d = mk();
      await expect(svc(d).resetPassword(7, password))
        .rejects.toMatchObject({ status: 400, response: { code: 1001 } });
      expect(d.adminsRepo.findById).not.toHaveBeenCalled();
      expect(d.adminsRepo.updateResearcherPassword).not.toHaveBeenCalled();
    }
  });

  it('目标不是教研员 → 404/1002，不写密码', async () => {
    const d = mk({ researcher: { id: 1, role: 'admin' } });
    await expect(svc(d).resetPassword(1, 'newpass1'))
      .rejects.toMatchObject({ status: 404, response: { code: 1002 } });
    expect(d.adminsRepo.updateResearcherPassword).not.toHaveBeenCalled();
  });
});
