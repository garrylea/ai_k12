import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface LessonRow extends RowDataPacket {
  id: number;
  unit_id: number;
  name: string;
  sort_order: number;
  is_unit_last: number;
}

export interface Lesson {
  id: number;
  unitId: number;
  name: string;
  sortOrder: number;
  isUnitLast: boolean;
}

@Injectable()
export class LessonsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async findByUnitId(unitId: number): Promise<Lesson[]> {
    const [rows] = await this.pool.execute<LessonRow[]>(
      'SELECT * FROM lessons WHERE unit_id = ? ORDER BY sort_order',
      [unitId],
    );
    return rows.map(this.mapRow);
  }

  async findById(id: number): Promise<Lesson | null> {
    const [rows] = await this.pool.execute<LessonRow[]>(
      'SELECT * FROM lessons WHERE id = ?', [id],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  /**
   * 找学习顺序上的上一节课：
   * 1) 同单元内 sort_order 更小的一课；
   * 2) 若当前是单元第一课，则取上一单元的最后一课；
   * 3) 若跨学期，继续往前推；
   * 4) 整本教材第一课返回 null。
   */
  async findPreviousLessonId(lessonId: number): Promise<number | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `WITH current AS (
         SELECT
           l.id,
           l.sort_order AS lesson_sort,
           u.id AS unit_id,
           u.sort_order AS unit_sort,
           s.id AS semester_id,
           s.sort_order AS semester_sort,
           tv.id AS textbook_version_id
         FROM lessons l
         JOIN units u ON l.unit_id = u.id
         JOIN semesters s ON u.semester_id = s.id
         JOIN textbook_versions tv ON s.textbook_version_id = tv.id
         WHERE l.id = ?
       ),
       prev_in_unit AS (
         SELECT l.id
         FROM lessons l
         JOIN units u ON l.unit_id = u.id
         JOIN current c ON u.id = c.unit_id
         WHERE l.sort_order < c.lesson_sort
         ORDER BY l.sort_order DESC
         LIMIT 1
       ),
       prev_unit_last AS (
         SELECT l.id
         FROM lessons l
         JOIN units u ON l.unit_id = u.id
         JOIN semesters s ON u.semester_id = s.id
         JOIN current c ON s.textbook_version_id = c.textbook_version_id
         WHERE (s.sort_order < c.semester_sort)
            OR (s.sort_order = c.semester_sort AND u.sort_order < c.unit_sort)
         ORDER BY s.sort_order DESC, u.sort_order DESC, l.sort_order DESC
         LIMIT 1
       )
       SELECT COALESCE((SELECT id FROM prev_in_unit), (SELECT id FROM prev_unit_last)) AS prev_lesson_id`,
      [lessonId],
    );
    return (rows[0]?.prev_lesson_id as number) ?? null;
  }

  private mapRow(row: LessonRow): Lesson {
    return {
      id: row.id,
      unitId: row.unit_id,
      name: row.name,
      sortOrder: row.sort_order,
      isUnitLast: row.is_unit_last === 1,
    };
  }
}
