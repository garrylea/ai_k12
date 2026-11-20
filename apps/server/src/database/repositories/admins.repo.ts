import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface AdminRow extends RowDataPacket {
  id: number;
  username: string;
  password_hash: string;
  name: string | null;
  is_active: number;
  role: 'admin' | 'researcher';
  deleted_at: Date | null;
}

export interface Admin {
  id: number;
  username: string;
  passwordHash: string;
  name: string | null;
  isActive: boolean;
  role: 'admin' | 'researcher';
}

export interface ResearcherRow extends RowDataPacket {
  id: number;
  username: string;
  name: string | null;
  is_active: number;
  created_at: Date;
}

export interface Researcher {
  id: number;
  username: string;
  name: string | null;
  isActive: boolean;
  createdAt: Date;
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

  async findById(id: number): Promise<Admin | null> {
    const [rows] = await this.pool.execute<AdminRow[]>(
      'SELECT * FROM admins WHERE id = ? AND deleted_at IS NULL',
      [id],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async updatePassword(id: number, passwordHash: string): Promise<void> {
    await this.pool.execute(
      'UPDATE admins SET password_hash = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
      [passwordHash, id],
    );
  }

  /**
   * 管理台教研员列表（2026-11-19）：角色硬过滤，**永不出 admin 行**。
   * 空 search 命中全部；按 id DESC，与家长/学生列表同序。
   */
  async listResearchers(q: string): Promise<Researcher[]> {
    const like = `%${q}%`;
    const [rows] = await this.pool.execute<ResearcherRow[]>(
      `SELECT id, username, name, is_active, created_at FROM admins
       WHERE role = 'researcher' AND deleted_at IS NULL AND (username LIKE ? OR name LIKE ?)
       ORDER BY id DESC LIMIT 50`,
      [like, like],
    );
    return rows.map((r) => this.mapResearcher(r));
  }

  /** 新建教研员：角色由 SQL 写死 `researcher`，调用方无从指定 admin。 */
  async createResearcher(data: { username: string; passwordHash: string; name: string | null }): Promise<number> {
    const [result] = await this.pool.execute(
      `INSERT INTO admins (username, password_hash, name, role) VALUES (?, ?, ?, 'researcher')`,
      [data.username, data.passwordHash, data.name],
    );
    return (result as { insertId: number }).insertId;
  }

  /** 启用/停用教研员：SQL 再带一次角色守卫，即便上层传错 id 也碰不到 admin。 */
  async setActive(id: number, isActive: boolean): Promise<void> {
    await this.pool.execute(
      `UPDATE admins SET is_active = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND role = 'researcher' AND deleted_at IS NULL`,
      [isActive ? 1 : 0, id],
    );
  }

  private mapResearcher(row: ResearcherRow): Researcher {
    return {
      id: row.id,
      username: row.username,
      name: row.name,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
    };
  }

  private mapRow(row: AdminRow): Admin {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      name: row.name,
      isActive: row.is_active === 1,
      role: row.role,
    };
  }
}
