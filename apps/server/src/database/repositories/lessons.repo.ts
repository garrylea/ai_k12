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
