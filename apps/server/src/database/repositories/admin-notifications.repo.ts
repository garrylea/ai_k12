import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface AdminNotificationRow {
  id: number;
  type: string;
  questionId: number | null;
  title: string;
  content: string;
  isRead: boolean;
  createdAt: Date;
}

@Injectable()
export class AdminNotificationsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async create(data: { type: string; questionId: number | null; title: string; content: string }): Promise<number> {
    const [r] = await this.pool.execute<ResultSetHeader>(
      'INSERT INTO admin_notifications (type, question_id, title, content) VALUES (?, ?, ?, ?)',
      [data.type, data.questionId, data.title, data.content]);
    return r.insertId;
  }

  /** 同题同 type 未读失败通知去重（防刷屏）：explanation-wait 超时前先查。 */
  async hasUnreadByQuestion(questionId: number, type: string): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM admin_notifications WHERE question_id = ? AND type = ? AND is_read = 0',
      [questionId, type]);
    return Number(rows[0].c) > 0;
  }

  async list(): Promise<AdminNotificationRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, type, question_id AS questionId, title, content, is_read AS isRead, created_at AS createdAt
       FROM admin_notifications ORDER BY created_at DESC LIMIT 200`);
    return rows.map((r: any) => ({ ...r, isRead: r.isRead === 1 }));
  }

  async unreadCount(): Promise<number> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM admin_notifications WHERE is_read = 0');
    return Number(rows[0].c);
  }

  async markRead(id: number): Promise<boolean> {
    const [r] = await this.pool.execute<ResultSetHeader>(
      'UPDATE admin_notifications SET is_read = 1, read_at = IFNULL(read_at, CURRENT_TIMESTAMP(3)) WHERE id = ?',
      [id]);
    if (r.affectedRows > 0) return true;  // 首次标已读
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id FROM admin_notifications WHERE id = ?',
      [id]);
    return rows.length > 0;               // 已读重复标 → 幂等 true；不存在 → false
  }
}
