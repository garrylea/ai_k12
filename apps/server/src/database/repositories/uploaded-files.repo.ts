import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { UploadedFileRow } from './types.js';

@Injectable()
export class UploadedFilesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<UploadedFileRow, 'id' | 'created_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO uploaded_files (uploader_id, uploader_type, url, mime_type, size_bytes, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.uploader_id, row.uploader_type, row.url, row.mime_type, row.size_bytes, row.source],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<UploadedFileRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM uploaded_files WHERE id = ?`,
      [id],
    );
    return (rows[0] as UploadedFileRow) ?? null;
  }
}
