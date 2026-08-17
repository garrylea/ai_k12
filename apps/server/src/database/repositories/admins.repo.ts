import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface AdminRow extends RowDataPacket {
  id: number;
  username: string;
  password_hash: string;
  name: string | null;
  is_active: number;
  deleted_at: Date | null;
}

export interface Admin {
  id: number;
  username: string;
  passwordHash: string;
  name: string | null;
  isActive: boolean;
}

@Injectable()
export class AdminsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async findByUsername(username: string): Promise<Admin | null> {
    const [rows] = await this.pool.execute<AdminRow[]>(
      'SELECT * FROM admins WHERE username = ? AND deleted_at IS NULL',
      [username],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  private mapRow(row: AdminRow): Admin {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      name: row.name,
      isActive: row.is_active === 1,
    };
  }
}
