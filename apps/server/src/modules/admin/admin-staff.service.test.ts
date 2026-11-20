import { describe, expect, it, vi } from 'vitest';
import * as bcrypt from 'bcrypt';
import { AdminStaffService } from './admin-staff.service.js';

function mk(over: { researcher?: any } = {}) {
  const researcher = over.researcher === undefined
    ? { id: 7, username: 'r1', passwordHash: 'old', name: '教研甲', isActive: true, role: 'researcher' }
    : over.researcher;
  return {
    adminsRepo: {
      listResearchers: vi.fn().mockResolvedValue([]),
      findByUsername: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(researcher),
      createResearcher: vi.fn().mockResolvedValue(11),
      setActive: vi.fn().mockResolvedValue(undefined),
      updatePassword: vi.fn().mockResolvedValue(undefined),
    },
    authSessionsRepo: { bumpAndReturnSeq: vi.fn().mockResolvedValue(4) },
    sessionRegistry: { bump: vi.fn() },
  };
}

const svc = (d: ReturnType<typeof mk>) =>
  new AdminStaffService(d.adminsRepo as any, d.authSessionsRepo as any, d.sessionRegistry as any);

describe('AdminStaffService.list', () => {
  it('原样返回列表项，不泄漏 passwordHash', async () => {
    const d = mk();
    d.adminsRepo.listResearchers.mockResolvedValue([
      { id: 7, username: 'r1', name: '教研甲', isActive: true, createdAt: new Date('2026-11-19T00:00:00Z'), passwordHash: 'secret' },
    ]);
    const out = await svc(d).list('jia');
    expect(d.adminsRepo.listResearchers).toHaveBeenCalledWith('jia');
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(out.items[0]).toMatchObject({ id: 7, username: 'r1', isActive: true });
  });
});

describe('AdminStaffService.create', () => {
  it('bcrypt 落库（不存明文），角色由 repo 固定 researcher', async () => {
    const d = mk();
    const out = await svc(d).create({ username: 'r2', name: '教研乙', password: 'pass123' });

    expect(out).toEqual({ id: 11, username: 'r2', name: '教研乙', isActive: true });
    const arg = d.adminsRepo.createResearcher.mock.calls[0][0];
    expect(arg.username).toBe('r2');
    expect(arg.passwordHash).not.toBe('pass123');
    await expect(bcrypt.compare('pass123', arg.passwordHash)).resolves.toBe(true);
  });

  it('name 缺省落 null', async () => {
    const d = mk();
    await svc(d).create({ username: 'r2', password: 'pass123' });
    expect(d.adminsRepo.createResearcher.mock.calls[0][0].name).toBeNull();
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
  it('bcrypt 写入 password_hash', async () => {
    const d = mk();
    await svc(d).resetPassword(7, 'newpass1');

    const [id, hash] = d.adminsRepo.updatePassword.mock.calls[0];
    expect(id).toBe(7);
    expect(hash).not.toBe('newpass1');
    await expect(bcrypt.compare('newpass1', hash)).resolves.toBe(true);
  });

  it('目标不是教研员 → 404/1002，不写密码', async () => {
    const d = mk({ researcher: { id: 1, role: 'admin' } });
    await expect(svc(d).resetPassword(1, 'newpass1'))
      .rejects.toMatchObject({ status: 404, response: { code: 1002 } });
    expect(d.adminsRepo.updatePassword).not.toHaveBeenCalled();
  });
});
