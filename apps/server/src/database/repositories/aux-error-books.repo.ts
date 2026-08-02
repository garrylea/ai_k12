import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AuxErrorBookRow } from './types.js';

@Injectable()
export class AuxErrorBooksRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<AuxErrorBookRow, 'id' | 'created_at' | 'updated_at' | 'cleared_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO aux_error_books
       (student_id, subject_id, question_id, level, is_cleared, source, wrong_answer_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.student_id, row.subject_id, row.question_id, row.level, row.is_cleared, row.source, row.wrong_answer_text],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<AuxErrorBookRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM aux_error_books WHERE id = ?`,
      [id],
    );
    return (rows[0] as AuxErrorBookRow) ?? null;
  }

  async findByStudent(studentId: number, subjectId?: number, includeCleared = false): Promise<AuxErrorBookRow[]> {
    const conditions = ['student_id = ?'];
    const params: any[] = [studentId];
    if (!includeCleared) {
      conditions.push('is_cleared = 0');
    }
    if (subjectId) {
      conditions.push('subject_id = ?');
      params.push(subjectId);
    }
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM aux_error_books WHERE ${conditions.join(' AND ')} ORDER BY id DESC`,
      params,
    );
    return rows as AuxErrorBookRow[];
  }

  async markCleared(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE aux_error_books SET is_cleared = 1, cleared_at = NOW(3) WHERE id = ?`,
      [id],
    );
  }

  async updateLevel(id: number, level: number): Promise<void> {
    await this.pool.execute(
      `UPDATE aux_error_books SET level = ? WHERE id = ?`,
      [level, id],
    );
  }
}
