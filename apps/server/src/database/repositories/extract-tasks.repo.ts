import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ExtractTaskRow } from './types.js';

@Injectable()
export class ExtractTasksRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<ExtractTaskRow, 'id' | 'created_at' | 'updated_at' | 'result' | 'error_message'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO extract_tasks (file_id, student_id, provider, status)
       VALUES (?, ?, ?, ?)`,
      [row.file_id, row.student_id, row.provider, row.status],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<ExtractTaskRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM extract_tasks WHERE id = ?`,
      [id],
    );
    return (rows[0] as ExtractTaskRow) ?? null;
  }

  async updateStatus(id: number, status: ExtractTaskRow['status'], result?: string, errorMessage?: string): Promise<void> {
    await this.pool.execute(
      `UPDATE extract_tasks SET status = ?, result = ?, error_message = ? WHERE id = ?`,
      [status, result ?? null, errorMessage ?? null, id],
    );
  }

  async findActiveByStudent(studentId: number): Promise<ExtractTaskRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM extract_tasks WHERE student_id = ? AND status IN ('pending', 'processing')`,
      [studentId],
    );
    return rows as ExtractTaskRow[];
  }

  async markStaleProcessingAsFailed(): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE extract_tasks SET status = 'failed', error_message = 'process restart - stale task', updated_at = NOW(3)
       WHERE status = 'processing' AND updated_at < NOW() - INTERVAL 5 MINUTE`,
    );
    return result.affectedRows;
  }
}
