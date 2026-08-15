import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { PracticeResultRow } from './types.js';

@Injectable()
export class PracticeResultsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * Upsert 一条判题结果（对/错都落库）。按 UNIQUE(student_id, card_id, question_n) 去重：
   * 单题重做即覆盖该行。best-effort：调用方（PracticeService.judge）负责 try/catch。
   */
  async upsert(row: {
    student_id: number;
    subject_id: number;
    card_id: number;
    lesson_id: number;
    question_id: number | null;
    question_n: string;
    question_text: string;
    student_answer: string;
    is_correct: boolean;
    method: 'exact' | 'ai';
    analysis: string | null;
    error_type: string | null;
  }): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO practice_results
         (student_id, subject_id, card_id, lesson_id, question_id, question_n, question_text,
          student_answer, is_correct, method, analysis, error_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         subject_id = VALUES(subject_id), lesson_id = VALUES(lesson_id), question_id = VALUES(question_id),
         question_text = VALUES(question_text), student_answer = VALUES(student_answer),
         is_correct = VALUES(is_correct), method = VALUES(method), analysis = VALUES(analysis),
         error_type = VALUES(error_type), judged_at = NOW(3)`,
      [row.student_id, row.subject_id, row.card_id, row.lesson_id, row.question_id, row.question_n,
       row.question_text, row.student_answer, row.is_correct ? 1 : 0, row.method, row.analysis, row.error_type],
    );
  }

  /** 取该学生在该卡的全部持久化判题结果。 */
  async findByStudentCard(studentId: number, cardId: number): Promise<PracticeResultRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM practice_results WHERE student_id = ? AND card_id = ? ORDER BY question_n`,
      [studentId, cardId],
    );
    return rows as PracticeResultRow[];
  }

  /** 取该学生在该课全部卡片的判题结果（课程完成门禁用）。 */
  async findByStudentLesson(studentId: number, lessonId: number): Promise<PracticeResultRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM practice_results WHERE student_id = ? AND lesson_id = ?`,
      [studentId, lessonId],
    );
    return rows as PracticeResultRow[];
  }

  /** 单卡 reset：删除该学生该卡的全部判题结果。 */
  async deleteByStudentCard(studentId: number, cardId: number): Promise<void> {
    await this.pool.execute(
      `DELETE FROM practice_results WHERE student_id = ? AND card_id = ?`,
      [studentId, cardId],
    );
  }

  /** 课程级 reset：删除该学生该课全部卡片的判题结果。 */
  async deleteByStudentLesson(studentId: number, lessonId: number): Promise<void> {
    await this.pool.execute(
      `DELETE FROM practice_results WHERE student_id = ? AND lesson_id = ?`,
      [studentId, lessonId],
    );
  }
}
