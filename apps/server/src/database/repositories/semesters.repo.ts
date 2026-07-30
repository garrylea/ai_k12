import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface SemesterRow extends RowDataPacket {
  id: number;
  textbook_version_id: number;
  name: string;
  grade: string;
  term: string;
  sort_order: number;
}

export interface Semester {
  id: number;
  textbookVersionId: number;
  name: string;
  grade: string;
  term: string;
  sortOrder: number;
}

@Injectable()
export class SemestersRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async findByTextbookVersionId(versionId: number): Promise<Semester[]> {
    const [rows] = await this.pool.execute<SemesterRow[]>(
      'SELECT * FROM semesters WHERE textbook_version_id = ? ORDER BY sort_order',
      [versionId],
    );
    return rows.map(this.mapRow);
  }

  async findById(id: number): Promise<Semester | null> {
    const [rows] = await this.pool.execute<SemesterRow[]>(
      'SELECT * FROM semesters WHERE id = ?', [id],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  private mapRow(row: SemesterRow): Semester {
    return {
      id: row.id,
      textbookVersionId: row.textbook_version_id,
      name: row.name,
      grade: row.grade,
      term: row.term,
      sortOrder: row.sort_order,
    };
  }
}
