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

  async findById(id: number): Promise<Parent | null> {
    const [rows] = await this.pool.execute<ParentRow[]>(
      'SELECT * FROM parents WHERE id = ? AND deleted_at IS NULL', [id]);
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  /** 家长改自己的密码（`PATCH /api/parent/password`）。照 `admins.repo.ts` 同款。 */
  async updatePassword(id: number, passwordHash: string): Promise<void> {
    await this.pool.execute(
      'UPDATE parents SET password_hash = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
      [passwordHash, id],
    );
  }

  async setActive(id: number, isActive: boolean): Promise<void> {
    await this.pool.execute(
      'UPDATE parents SET is_active = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
      [isActive ? 1 : 0, id],
    );
  }

  /** 管理台搜索：手机号/姓名模糊，附名下学生数。 */
  async search(q: string): Promise<Array<Parent & { studentCount: number }>> {
    const like = `%${q}%`;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT p.*, (SELECT COUNT(*) FROM students s WHERE s.parent_id = p.id AND s.deleted_at IS NULL) AS studentCount
       FROM parents p
       WHERE p.deleted_at IS NULL AND (p.phone LIKE ? OR p.name LIKE ?)
       ORDER BY p.id DESC LIMIT 50`, [like, like]);
    return rows.map((r: any) => ({ ...this.mapRow(r), studentCount: Number(r.studentCount) }));
  }

  /** 启动重建封禁名单用：所有停用（未软删）家长。 */
  async listInactive(): Promise<Parent[]> {
    const [rows] = await this.pool.execute<ParentRow[]>(
      'SELECT * FROM parents WHERE is_active = 0 AND deleted_at IS NULL',
    );
    return rows.map((r) => this.mapRow(r));
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
