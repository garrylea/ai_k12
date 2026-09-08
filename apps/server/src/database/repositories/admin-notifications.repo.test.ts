import { describe, it, expect, vi } from 'vitest';
import { AdminNotificationsRepository } from './admin-notifications.repo.js';

describe('AdminNotificationsRepository', () => {
  it('hasUnreadByQuestion：无未读时 false，有未读时 true', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ c: 0 }]]) };
    const repo = new AdminNotificationsRepository(pool as any);
    expect(await repo.hasUnreadByQuestion(5)).toBe(false);
    expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('is_read = 0'), [5]);
  });

  it('create 返回 insertId', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ insertId: 9 }]) };
    const repo = new AdminNotificationsRepository(pool as any);
    expect(await repo.create({ type: 'explanation_failed', questionId: 5, title: 't', content: 'c' })).toBe(9);
  });

  it('list 映射 isRead 布尔', async () => {
    const row = { id: 1, type: 'explanation_failed', questionId: 5, title: 't', content: 'c', isRead: 1, createdAt: new Date() };
    const pool = { execute: vi.fn().mockResolvedValue([[row]]) };
    const repo = new AdminNotificationsRepository(pool as any);
    const list = await repo.list();
    expect(list[0].isRead).toBe(true);
  });

  it('unreadCount 与 markRead', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ c: 2 }]]) };
    const repo = new AdminNotificationsRepository(pool as any);
    expect(await repo.unreadCount()).toBe(2);
  });
});
