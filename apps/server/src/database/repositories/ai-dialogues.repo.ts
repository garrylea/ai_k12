import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AiDialogueRow } from './types.js';

@Injectable()
export class AiDialoguesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<AiDialogueRow, 'id' | 'created_at' | 'updated_at' | 'deleted_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ai_dialogues
       (student_id, subject_id, track, card_id, knowledge_point_id, title, status, consecutive_fail_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.student_id, row.subject_id, row.track, row.card_id, row.knowledge_point_id, row.title, row.status, row.consecutive_fail_count],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<AiDialogueRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ai_dialogues WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return (rows[0] as AiDialogueRow) ?? null;
  }

  async findByStudentAndTrack(studentId: number, track: AiDialogueRow['track'], limit: number, cursor?: number): Promise<AiDialogueRow[]> {
    const clause = cursor ? 'AND id < ?' : '';
    const params = cursor ? [studentId, track, cursor, limit] : [studentId, track, limit];
    // Use pool.query (client-side escaping) instead of pool.execute (server-side
    // prepared statements): MySQL rejects `LIMIT ?` as a prepared-statement
    // placeholder with "Incorrect arguments to mysqld_stmt_execute". The `?`
    // values are still parameterized/escaped by mysql2, so no injection risk.
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM ai_dialogues
       WHERE student_id = ? AND track = ? AND deleted_at IS NULL ${clause}
       ORDER BY id DESC LIMIT ?`,
      params,
    );
    return rows as AiDialogueRow[];
  }

  async updateTitle(id: number, title: string): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET title = ? WHERE id = ?`,
      [title, id],
    );
  }

  async archive(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET status = 'archived' WHERE id = ?`,
      [id],
    );
  }

  async softDelete(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET deleted_at = NOW() WHERE id = ?`,
      [id],
    );
  }

  async updateFailCount(id: number, count: number): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET consecutive_fail_count = ? WHERE id = ?`,
      [count, id],
    );
  }

  async incrementFailCount(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET consecutive_fail_count = consecutive_fail_count + 1 WHERE id = ?`,
      [id],
    );
  }
}
