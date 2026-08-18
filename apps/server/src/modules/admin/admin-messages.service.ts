import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { ParentMessagesRepository } from '../../database/repositories/parent-messages.repo.js';
import { ParentsRepository } from '../../database/repositories/parents.repo.js';

const TYPES = ['promo', 'learning', 'system'] as const;

@Injectable()
export class AdminMessagesService {
  constructor(
    private messagesRepo: ParentMessagesRepository,
    private parentsRepo: ParentsRepository,
  ) {}

  async send(dto: { type: string; title: string; content: string; parentId?: number }) {
    if (!(TYPES as readonly string[]).includes(dto.type)) {
      throw new ConflictException({ code: 1001, message: '消息类型不合法' });
    }
    let parentId: number | null = null;
    if (dto.parentId !== undefined) {
      const p = await this.parentsRepo.findById(dto.parentId);
      if (!p) throw new NotFoundException({ code: 1002, message: '家长不存在' });
      parentId = dto.parentId;
    }
    return { id: await this.messagesRepo.create({ parentId, type: dto.type, title: dto.title, content: dto.content }) };
  }

  async listForAdmin() { return this.messagesRepo.listForAdmin(); }
  async remove(id: number) { await this.messagesRepo.delete(id); }

  // 家长侧（ParentController 复用）
  async listForParent(parentId: number) { return this.messagesRepo.listForParent(parentId); }
  async unreadCount(parentId: number) { return this.messagesRepo.unreadCount(parentId); }
  async markRead(parentId: number, messageId: number) {
    const ok = await this.messagesRepo.markRead(parentId, messageId);
    if (!ok) throw new NotFoundException({ code: 1002, message: '消息不存在' });
  }
}
