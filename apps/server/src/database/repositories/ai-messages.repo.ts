import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AiMessageRow } from './types.js';

@Injectable()
export class AiMessagesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<AiMessageRow, 'id' | 'created_at' | 'deleted_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ai_messages
       (dialogue_id, role, content, type, attachments, model, token_input, token_output, response_time_ms, safety_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.dialogue_id, row.role, row.content, row.type, row.attachments, row.model, row.token_input, row.token_output, row.response_time_ms, row.safety_flag],
    );
    return result.insertId;
  }

  async createMany(rows: Array<Omit<AiMessageRow, 'id' | 'created_at' | 'deleted_at'>>): Promise<void> {
    if (rows.length === 0) return;
    const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
    const values = rows.flatMap((r) => [r.dialogue_id, r.role, r.content, r.type, r.attachments, r.model, r.token_input, r.token_output, r.response_time_ms, r.safety_flag]);
    await this.pool.query(
      `INSERT INTO ai_messages
       (dialogue_id, role, content, type, attachments, model, token_input, token_output, response_time_ms, safety_flag)
       VALUES ${placeholders}`,
      values,
    );
  }

  async findByDialogue(dialogueId: number, lastMessageId?: number): Promise<AiMessageRow[]> {
    const clause = lastMessageId ? 'AND id > ?' : '';
    const params = lastMessageId ? [dialogueId, lastMessageId] : [dialogueId];
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ai_messages WHERE dialogue_id = ? AND deleted_at IS NULL ${clause} ORDER BY id ASC`,
      params,
    );
    return rows as AiMessageRow[];
  }
}
