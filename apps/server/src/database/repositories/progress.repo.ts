import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface ProgressRow extends RowDataPacket {
  id: number;
  student_id: number;
  subject_id: number;
  textbook_version_id: number;
  current_semester_id: number | null;
  current_unit_id: number | null;
  current_lesson_id: number | null;
  current_card_sort: number | null;
  next_unlock_type: string;
  is_clear: number;
  status: string;
}

export interface Progress {
  id: number;
  studentId: number;
  subjectId: number;
  textbookVersionId: number;
  currentSemesterId: number | null;
  currentUnitId: number | null;
  currentLessonId: number | null;
  currentCardSort: number | null;
  nextUnlockType: string;
  isClear: boolean;
  status: string;
}

@Injectable()
export class ProgressRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async findByStudentAndSubject(studentId: number, subjectId: number): Promise<Progress | null> {
    const [rows] = await this.pool.execute<ProgressRow[]>(
      'SELECT * FROM progress WHERE student_id = ? AND subject_id = ?',
      [studentId, subjectId],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async create(data: {
    studentId: number;
    subjectId: number;
    textbookVersionId: number;
    semesterId: number;
    currentUnitId: number;
    currentLessonId: number;
  }): Promise<number> {
    const [result] = await this.pool.execute(
      `INSERT INTO progress
       (student_id, subject_id, textbook_version_id, current_semester_id, current_unit_id, current_lesson_id, current_card_sort, next_unlock_type, is_clear, status)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'lesson', 1, 'in_progress')`,
      [data.studentId, data.subjectId, data.textbookVersionId, data.semesterId, data.currentUnitId, data.currentLessonId],
    );
    return (result as any).insertId;
  }

  async updateCardSort(progressId: number, currentCardSort: number, nextUnlockType: string): Promise<void> {
    await this.pool.execute(
      `UPDATE progress SET current_card_sort = ?, next_unlock_type = ? WHERE id = ?`,
      [currentCardSort, nextUnlockType, progressId],
    );
  }

  async advanceLesson(progressId: number, nextLessonId: number, nextUnitId: number | null): Promise<void> {
    if (nextUnitId != null) {
      await this.pool.execute(
        `UPDATE progress SET current_unit_id = ?, current_lesson_id = ?, current_card_sort = 0, next_unlock_type = 'lesson' WHERE id = ?`,
        [nextUnitId, nextLessonId, progressId],
      );
    } else {
      await this.pool.execute(
        `UPDATE progress SET current_lesson_id = ?, current_card_sort = 0, next_unlock_type = 'lesson' WHERE id = ?`,
        [nextLessonId, progressId],
      );
    }
  }

  async markCompleted(progressId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE progress SET status = 'completed', next_unlock_type = 'lesson' WHERE id = ?`,
      [progressId],
    );
  }

  private mapRow(row: ProgressRow): Progress {
    return {
      id: row.id,
      studentId: row.student_id,
      subjectId: row.subject_id,
      textbookVersionId: row.textbook_version_id,
      currentSemesterId: row.current_semester_id,
      currentUnitId: row.current_unit_id,
      currentLessonId: row.current_lesson_id,
      currentCardSort: row.current_card_sort,
      nextUnlockType: row.next_unlock_type,
      isClear: row.is_clear === 1,
      status: row.status,
    };
  }
}
