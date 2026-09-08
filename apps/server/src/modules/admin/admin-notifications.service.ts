import { Injectable, NotFoundException } from '@nestjs/common';
import { AdminNotificationsRepository } from '../../database/repositories/admin-notifications.repo.js';

@Injectable()
export class AdminNotificationsService {
  constructor(private readonly notificationsRepo: AdminNotificationsRepository) {}

  async list() { return this.notificationsRepo.list(); }
  async unreadCount() { return this.notificationsRepo.unreadCount(); }
  async markRead(id: number) {
    const ok = await this.notificationsRepo.markRead(id);
    if (!ok) throw new NotFoundException({ code: 1002, message: '通知不存在' });
  }
}
