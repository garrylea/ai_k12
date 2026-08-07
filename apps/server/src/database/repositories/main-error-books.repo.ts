import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { MainErrorBookRow } from './types.js';

@Injectable()
export class MainErrorBooksRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 插入一条主线错题。level / is_cleared 走 DB 默认值（1 / 0）。
   * question_id 可为 null（题库无匹配、质量差仅存题面场景）。
   */
  async create(row: {
    student_id: number;
    subject_id: number;
    question_id: number | null;
    source: string;
    source_ref_id: number | null;
    wrong_answer_text: string | null;
  }): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO main_error_books
       (student_id, subject_id, question_id, source, source_ref_id, wrong_answer_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.student_id, row.subject_id, row.question_id, row.source, row.source_ref_id, row.wrong_answer_text],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<MainErrorBookRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM main_error_books WHERE id = ?`,
      [id],
    );
    return (rows[0] as MainErrorBookRow) ?? null;
  }

  async findByStudent(studentId: number, subjectId?: number, includeCleared = false): Promise<MainErrorBookRow[]> {
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
      `SELECT * FROM main_error_books WHERE ${conditions.join(' AND ')} ORDER BY id DESC`,
      params,
    );
    return rows as MainErrorBookRow[];
  }

  async markCleared(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE main_error_books SET is_cleared = 1, cleared_at = NOW(3) WHERE id = ?`,
      [id],
    );
  }

  async updateLevel(id: number, level: number): Promise<void> {
    await this.pool.execute(
      `UPDATE main_error_books SET level = ? WHERE id = ?`,
      [level, id],
    );
  }
}
