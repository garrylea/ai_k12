import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface ParentRow extends RowDataPacket {
  id: number;
  phone: string;
  password_hash: string;
  name: string | null;
  is_active: number;
  deleted_at: Date | null;
}

export interface Parent {
  id: number;
  phone: string;
  passwordHash: string;
  name: string | null;
  isActive: boolean;
}

@Injectable()
export class ParentsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  /** 软删行（deleted_at 非空）不返回，同手机号可重新注册。 */
  async findByPhone(phone: string): Promise<Parent | null> {
    const [rows] = await this.pool.execute<ParentRow[]>(
      'SELECT * FROM parents WHERE phone = ? AND deleted_at IS NULL',
      [phone],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async create(data: { phone: string; passwordHash: string; name?: string }): Promise<number> {
    const [result] = await this.pool.execute(
      'INSERT INTO parents (phone, password_hash, name) VALUES (?, ?, ?)',
      [data.phone, data.passwordHash, data.name ?? null],
    );
    return (result as any).insertId;
  }

  private mapRow(row: ParentRow): Parent {
    return {
      id: row.id,
      phone: row.phone,
      passwordHash: row.password_hash,
      name: row.name,
      isActive: row.is_active === 1,
    };
  }
}
