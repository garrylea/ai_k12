import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface SubjectRow extends RowDataPacket {
  id: number;
  name: string;
  code: string;
  grade_bands: string;
  icon_url: string | null;
  sort_order: number;
  is_active: number;
}

export interface Subject {
  id: number;
  name: string;
  code: string;
  gradeBands: string[];
  iconUrl: string | null;
  sortOrder: number;
  isActive: boolean;
}

@Injectable()
export class SubjectsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async findAll(): Promise<Subject[]> {
    const [rows] = await this.pool.execute<SubjectRow[]>(
      'SELECT * FROM subjects WHERE is_active = 1 ORDER BY sort_order',
    );
    return rows.map(this.mapRow);
  }

  async findById(id: number): Promise<Subject | null> {
    const [rows] = await this.pool.execute<SubjectRow[]>(
      'SELECT * FROM subjects WHERE id = ? AND is_active = 1',
      [id],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async findByCode(code: string): Promise<Subject | null> {
    const [rows] = await this.pool.execute<SubjectRow[]>(
      'SELECT * FROM subjects WHERE code = ? AND is_active = 1',
      [code],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  private mapRow(row: SubjectRow): Subject {
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      gradeBands: row.grade_bands ? row.grade_bands.split(',') : [],
      iconUrl: row.icon_url,
      sortOrder: row.sort_order,
      isActive: row.is_active === 1,
    };
  }
}
