import { describe, it, expect, vi } from 'vitest';
import { AdminMessagesService } from './admin-messages.service';

const mk = (o: any = {}) => ({
  messagesRepo: {
    create: vi.fn().mockResolvedValue(1), listForAdmin: vi.fn().mockResolvedValue([]),
    listForParent: vi.fn().mockResolvedValue([]), unreadCount: vi.fn().mockResolvedValue(0),
    markRead: vi.fn().mockResolvedValue(true), delete: vi.fn(),
  },
  parentsRepo: { findById: vi.fn().mockResolvedValue(null) },
  ...o,
});
const svc = (d: any) => new AdminMessagesService(d.messagesRepo, d.parentsRepo);

describe('AdminMessagesService', () => {
  it('广播发送 parentId=null；指定家长先校验存在（1002）', async () => {
    const d = mk();
    await svc(d).send({ type: 'promo', title: 't', content: 'c' });
    expect(d.messagesRepo.create).toHaveBeenCalledWith(expect.objectContaining({ parentId: null }));
    const d2 = mk();
    await expect(svc(d2).send({ type: 'promo', title: 't', content: 'c', parentId: 99 }))
      .rejects.toMatchObject({ response: { code: 1002 } });
  });

  it('非法 type -> 1001', async () => {
    await expect(svc(mk()).send({ type: 'bad', title: 't', content: 'c' }))
      .rejects.toMatchObject({ response: { code: 1001 } });
  });

  it('家长列表/未读/已读透传', async () => {
    const d = mk();
    await svc(d).listForParent(3);
    await svc(d).unreadCount(3);
    await svc(d).markRead(3, 7);
    expect(d.messagesRepo.listForParent).toHaveBeenCalledWith(3);
    expect(d.messagesRepo.markRead).toHaveBeenCalledWith(3, 7);
  });

  it('markRead 非本人定向消息 -> 1002', async () => {
    const d = mk({ messagesRepo: { ...mk().messagesRepo, markRead: vi.fn().mockResolvedValue(false) } });
    await expect(svc(d).markRead(3, 7)).rejects.toMatchObject({ response: { code: 1002 } });
  });
});
