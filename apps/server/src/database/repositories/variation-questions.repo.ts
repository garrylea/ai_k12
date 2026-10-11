import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface VariationQuestionRow {
  id: number;
  original_error_item_id: number;
  error_book_type: string;
  student_id: number;
  question_id: number;
  difficulty: number;
  validator_passed: number;
  is_correct: number | null;
  answered_at: Date | null;
  created_at: Date;
}

export interface VariationPendingRow {
  id: number;
  original_error_item_id: number;
  question_id: number;
  difficulty: number;
}

@Injectable()
export class VariationQuestionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 该错题条目是否还有待练变式（生成器 DB 层去重用）。 */
  async hasPendingByErrorItem(errorItemId: number): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM variation_questions
       WHERE original_error_item_id = ? AND is_correct IS NULL LIMIT 1`,
      [errorItemId],
    );
    return rows.length > 0;
  }

  /** 学生的 pending 变式（可选按错题条目过滤）；不 join questions，题目由调用方批量取。 */
  async findPendingByStudent(studentId: number, errorBookId?: number): Promise<VariationPendingRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, original_error_item_id, question_id, difficulty FROM variation_questions
       WHERE student_id = ? AND is_correct IS NULL${errorBookId != null ? ' AND original_error_item_id = ?' : ''}
       ORDER BY id DESC`,
      errorBookId != null ? [studentId, errorBookId] : [studentId],
    );
    return rows as VariationPendingRow[];
  }

  /** 按题目找 pending 行（作答落定前置校验用；一题一 pending 行，取最新）。 */
  async findPendingByQuestion(studentId: number, questionId: number): Promise<VariationQuestionRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM variation_questions
       WHERE student_id = ? AND question_id = ? AND is_correct IS NULL ORDER BY id DESC LIMIT 1`,
      [studentId, questionId],
    );
    return (rows[0] as VariationQuestionRow) ?? null;
  }

  async insert(row: {
    original_error_item_id: number;
    error_book_type: string;
    student_id: number;
    question_id: number;
    difficulty: number;
    validator_passed: number;
  }): Promise<number> {
    // is_correct / answered_at 不写，走 DB 默认 NULL（= 待练）
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO variation_questions
        (original_error_item_id, error_book_type, student_id, question_id, difficulty, validator_passed)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        row.original_error_item_id,
        row.error_book_type,
        row.student_id,
        row.question_id,
        row.difficulty,
        row.validator_passed,
      ],
    );
    return result.insertId;
  }

  /** CAS 落定（用户裁决 D1：一次作答即落定，不重出）。
   *  affectedRows = 0 即已被并发作答，调用方按「不在待练清单」处理。 */
  async markAnswered(id: number, isCorrect: boolean): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE variation_questions SET is_correct = ?, answered_at = NOW(3) WHERE id = ? AND is_correct IS NULL`,
      [isCorrect ? 1 : 0, id],
    );
    return result.affectedRows;
  }
}
