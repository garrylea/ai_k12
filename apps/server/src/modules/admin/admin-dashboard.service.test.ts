import { describe, it, expect, vi } from 'vitest';
import * as bcrypt from 'bcrypt';
import { AdminDashboardService } from './admin-dashboard.service';

const mkPool = (results: any[]) => ({
  execute: vi.fn().mockImplementation(() => Promise.resolve([results.shift() ?? [], []])),
});

const mkAdmin = (passwordHash: string) => ({
  id: 1, username: 'admin', passwordHash, name: null, isActive: true,
});

describe('AdminDashboardService', () => {
  it('四计数 + recentParents', async () => {
    const pool = mkPool([
      [{ c: 12 }],           // parents
      [{ c: 34 }],           // students
      [{ c: 5 }],            // today ai dialogues
      [{ c: 6 }],            // enabled models
      [{ id: 1, phone: '13800000000', name: '甲', isActive: true, studentCount: 2, createdAt: new Date() }], // recent parents
    ]);
    const svc = new AdminDashboardService(pool as any, {} as any);
    const r = await svc.get();
    expect(r).toMatchObject({ parentCount: 12, studentCount: 34, todayAiCalls: 5, enabledModelCount: 6 });
    expect(r.recentParents).toHaveLength(1);
    expect(r.recentParents[0].phone).toBe('13800000000');
  });

  it('改密：旧密码错误 -> 1003，不调 updatePassword', async () => {
    const hash = await bcrypt.hash('old-pass', 4);
    const repo = { findById: vi.fn().mockResolvedValue(mkAdmin(hash)), updatePassword: vi.fn() };
    const svc = new AdminDashboardService(mkPool([]) as any, repo as any);
    await expect(svc.changePassword(1, 'wrong-pass', 'new-pass-1')).rejects.toMatchObject({ response: { code: 1003 } });
    expect(repo.updatePassword).not.toHaveBeenCalled();
  });

  it('改密：成功 -> updatePassword 收到新 hash', async () => {
    const hash = await bcrypt.hash('old-pass', 4);
    const repo = { findById: vi.fn().mockResolvedValue(mkAdmin(hash)), updatePassword: vi.fn() };
    const svc = new AdminDashboardService(mkPool([]) as any, repo as any);
    await svc.changePassword(1, 'old-pass', 'new-pass-1');
    expect(repo.updatePassword).toHaveBeenCalledTimes(1);
    expect(repo.updatePassword).toHaveBeenCalledWith(1, expect.any(String));
    const newHash = repo.updatePassword.mock.calls[0][1] as string;
    expect(await bcrypt.compare('new-pass-1', newHash)).toBe(true);
  });

  it('改密：新密码长度不合法 -> 1001', async () => {
    const repo = { findById: vi.fn(), updatePassword: vi.fn() };
    const svc = new AdminDashboardService(mkPool([]) as any, repo as any);
    await expect(svc.changePassword(1, 'old-pass', 'short')).rejects.toMatchObject({ response: { code: 1001 } });
  });

  it('改密：管理员不存在 -> 1002', async () => {
    const repo = { findById: vi.fn().mockResolvedValue(null), updatePassword: vi.fn() };
    const svc = new AdminDashboardService(mkPool([]) as any, repo as any);
    await expect(svc.changePassword(99, 'old-pass', 'new-pass-1')).rejects.toMatchObject({ response: { code: 1002 } });
  });
});
