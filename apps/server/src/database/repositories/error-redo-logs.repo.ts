import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ErrorRedoLogRow } from './types.js';

@Injectable()
export class ErrorRedoLogsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<ErrorRedoLogRow, 'id' | 'created_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO error_redo_logs
       (error_book_type, error_item_id, student_id, answer_text, attachments, is_correct, error_level_before, error_level_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.error_book_type, row.error_item_id, row.student_id, row.answer_text, row.attachments, row.is_correct, row.error_level_before, row.error_level_after],
    );
    return result.insertId;
  }
}
