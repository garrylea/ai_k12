import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface TextbookVersionRow extends RowDataPacket {
  id: number;
  subject_id: number;
  name: string;
  code: string;
  grade_band: string;
  publisher: string | null;
  edition: string;
  is_active: number;
}

export interface TextbookVersion {
  id: number;
  subjectId: number;
  name: string;
  code: string;
  gradeBand: string;
  publisher: string | null;
  edition: string;
  isActive: boolean;
}

@Injectable()
export class TextbookVersionsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async findBySubjectId(subjectId: number): Promise<TextbookVersion[]> {
    const [rows] = await this.pool.execute<TextbookVersionRow[]>(
      'SELECT * FROM textbook_versions WHERE subject_id = ? AND is_active = 1 ORDER BY id',
      [subjectId],
    );
    return rows.map(this.mapRow);
  }

  async findById(id: number): Promise<TextbookVersion | null> {
    const [rows] = await this.pool.execute<TextbookVersionRow[]>(
      'SELECT * FROM textbook_versions WHERE id = ? AND is_active = 1',
      [id],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  private mapRow(row: TextbookVersionRow): TextbookVersion {
    return {
      id: row.id,
      subjectId: row.subject_id,
      name: row.name,
      code: row.code,
      gradeBand: row.grade_band,
      publisher: row.publisher,
      edition: row.edition ?? '',
      isActive: row.is_active === 1,
    };
  }
}
