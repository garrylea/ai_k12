import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface UnitRow extends RowDataPacket {
  id: number;
  semester_id: number;
  name: string;
  sort_order: number;
  is_midterm_boundary: number;
}

export interface Unit {
  id: number;
  semesterId: number;
  name: string;
  sortOrder: number;
  isMidtermBoundary: boolean;
}

@Injectable()
export class UnitsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async findBySemesterId(semesterId: number): Promise<Unit[]> {
    const [rows] = await this.pool.execute<UnitRow[]>(
      'SELECT * FROM units WHERE semester_id = ? ORDER BY sort_order',
      [semesterId],
    );
    return rows.map(this.mapRow);
  }

  async findById(id: number): Promise<Unit | null> {
    const [rows] = await this.pool.execute<UnitRow[]>(
      'SELECT * FROM units WHERE id = ?', [id],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  private mapRow(row: UnitRow): Unit {
    return {
      id: row.id,
      semesterId: row.semester_id,
      name: row.name,
      sortOrder: row.sort_order,
      isMidtermBoundary: row.is_midterm_boundary === 1,
    };
  }
}
