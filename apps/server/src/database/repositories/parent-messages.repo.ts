import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface ParentMessage {
  id: number; parentId: number | null; type: string; title: string; content: string;
  isRead: boolean; isBroadcast: boolean; createdAt: Date;
}

@Injectable()
export class ParentMessagesRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async create(data: { parentId: number | null; type: string; title: string; content: string }): Promise<number> {
    const [r] = await this.pool.execute(
      'INSERT INTO parent_messages (parent_id, type, title, content) VALUES (?, ?, ?, ?)',
      [data.parentId, data.type, data.title, data.content]);
    return (r as any).insertId;
  }

  async findById(id: number) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id, parent_id AS parentId, type, title, content, is_read AS isRead, created_at AS createdAt FROM parent_messages WHERE id = ?', [id]);
    return rows.length > 0 ? rows[0] : null;
  }

  async delete(id: number): Promise<void> {
    await this.pool.execute('DELETE FROM message_reads WHERE message_id = ?', [id]);
    await this.pool.execute('DELETE FROM parent_messages WHERE id = ?', [id]);
  }

  /** 家长视角：定向（自己）+广播（NULL），合并已读状态。 */
  async listForParent(parentId: number): Promise<ParentMessage[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT m.id, m.parent_id AS parentId, m.type, m.title, m.content, m.created_at AS createdAt,
              CASE WHEN m.parent_id IS NULL THEN (mr.id IS NOT NULL) ELSE (m.is_read = 1) END AS isRead,
              (m.parent_id IS NULL) AS isBroadcast
       FROM parent_messages m
       LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.parent_id = ?
       WHERE m.parent_id = ? OR m.parent_id IS NULL
       ORDER BY m.created_at DESC LIMIT 100`, [parentId, parentId]);
    return rows.map((r: any) => ({ ...r, isRead: r.isRead === 1, isBroadcast: r.isBroadcast === 1 }));
  }

  async unreadCount(parentId: number): Promise<number> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM parent_messages m
       LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.parent_id = ?
       WHERE (m.parent_id = ? AND m.is_read = 0) OR (m.parent_id IS NULL AND mr.id IS NULL)`,
      [parentId, parentId]);
    return Number(rows[0].c);
  }

  /** 标已读：广播 upsert message_reads；定向改行。返回消息是否属于该家长（或广播）。 */
  async markRead(parentId: number, messageId: number): Promise<boolean> {
    const msg = await this.findById(messageId);
    if (!msg || (msg.parentId !== null && Number(msg.parentId) !== parentId)) return false;
    if (msg.parentId === null) {
      await this.pool.execute(
        'INSERT INTO message_reads (parent_id, message_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE read_at = CURRENT_TIMESTAMP(3)',
        [parentId, messageId]);
    } else {
      await this.pool.execute(
        'UPDATE parent_messages SET is_read = 1, read_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [messageId]);
    }
    return true;
  }

  /** 管理台列表：触达数（广播=活跃家长数，定向=1）与已读数。 */
  async listForAdmin() {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT m.id, m.type, m.title, (m.parent_id IS NULL) AS isBroadcast, m.created_at AS createdAt,
              CASE WHEN m.parent_id IS NULL THEN (SELECT COUNT(*) FROM parents p WHERE p.deleted_at IS NULL) ELSE 1 END AS reachCount,
              CASE WHEN m.parent_id IS NULL THEN (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) ELSE m.is_read END AS readCount
       FROM parent_messages m ORDER BY m.created_at DESC LIMIT 200`);
    return rows.map((r: any) => ({ ...r, isBroadcast: r.isBroadcast === 1, reachCount: Number(r.reachCount), readCount: Number(r.readCount) }));
  }
}
