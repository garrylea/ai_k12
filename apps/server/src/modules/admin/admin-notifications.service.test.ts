import { describe, it, expect, vi } from 'vitest';
import { AdminNotificationsService } from './admin-notifications.service';

const mk = (o: any = {}) => ({
  notificationsRepo: {
    list: vi.fn().mockResolvedValue([]),
    unreadCount: vi.fn().mockResolvedValue(0),
    markRead: vi.fn().mockResolvedValue(true),
  },
  ...o,
});
const svc = (d: any) => new AdminNotificationsService(d.notificationsRepo);

describe('AdminNotificationsService', () => {
  it('list/unreadCount 透传 repo', async () => {
    const d = mk();
    await svc(d).list();
    await svc(d).unreadCount();
    expect(d.notificationsRepo.list).toHaveBeenCalledOnce();
    expect(d.notificationsRepo.unreadCount).toHaveBeenCalledOnce();
  });

  it('markRead 已读成功透传', async () => {
    const d = mk();
    await svc(d).markRead(3);
    expect(d.notificationsRepo.markRead).toHaveBeenCalledWith(3);
  });

  it('已读重复标（repo 幂等 true）不抛 404', async () => {
    const d = mk(); // repo.markRead mockResolvedValue(true)
    await expect(svc(d).markRead(3)).resolves.toBeUndefined();
  });

  it('markRead 不存在 -> 1002', async () => {
    const d = mk({ notificationsRepo: { ...mk().notificationsRepo, markRead: vi.fn().mockResolvedValue(false) } });
    await expect(svc(d).markRead(99)).rejects.toMatchObject({ response: { code: 1002 } });
  });
});
