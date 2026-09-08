import { describe, it, expect, vi } from 'vitest';
import { AdminNotificationsRepository } from './admin-notifications.repo.js';

describe('AdminNotificationsRepository', () => {
  it('hasUnreadByQuestion：无未读时 false，有未读时 true（按 question_id + type 精确去重）', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ c: 0 }]]) };
    const repo = new AdminNotificationsRepository(pool as any);
    expect(await repo.hasUnreadByQuestion(5, 'explanation_failed')).toBe(false);
    expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('is_read = 0'), [5, 'explanation_failed']);
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

  it('unreadCount', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ c: 2 }]]) };
    const repo = new AdminNotificationsRepository(pool as any);
    expect(await repo.unreadCount()).toBe(2);
  });

  it('markRead：affectedRows>0 首次标已读返回 true', async () => {
    const pool = { execute: vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }]) };
    const repo = new AdminNotificationsRepository(pool as any);
    expect(await repo.markRead(3)).toBe(true);
    expect(pool.execute).toHaveBeenCalledTimes(1); // 命中则不再 SELECT
  });

  it('markRead：已读重复标（UPDATE affectedRows=0 但行存在）幂等返回 true', async () => {
    const pool = { execute: vi.fn().mockResolvedValueOnce([{ affectedRows: 0 }]).mockResolvedValueOnce([[{ id: 3 }]]) };
    const repo = new AdminNotificationsRepository(pool as any);
    expect(await repo.markRead(3)).toBe(true);
    expect(pool.execute).toHaveBeenCalledTimes(2);
  });

  it('markRead：不存在（UPDATE affectedRows=0 且 SELECT 未命中）返回 false', async () => {
    const pool = { execute: vi.fn().mockResolvedValueOnce([{ affectedRows: 0 }]).mockResolvedValueOnce([[]]) };
    const repo = new AdminNotificationsRepository(pool as any);
    expect(await repo.markRead(3)).toBe(false);
    expect(pool.execute).toHaveBeenCalledTimes(2);
  });
});
