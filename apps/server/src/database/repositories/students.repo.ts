import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface StudentRow extends RowDataPacket {
  id: number;
  parent_id: number;
  username: string;
  password_hash: string;
  name: string;
  age: number | null;
  grade: string | null;
  school_level: string | null;
  is_active: number;
  deleted_at: Date | null;
}

export interface Student {
  id: number;
  parentId: number;
  username: string;
  passwordHash: string;
  name: string;
  age: number | null;
  grade: string | null;
  schoolLevel: string | null;
  isActive: boolean;
}

@Injectable()
export class StudentsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async findById(id: number): Promise<Student | null> {
    const [rows] = await this.pool.execute<StudentRow[]>(
      'SELECT * FROM students WHERE id = ? AND deleted_at IS NULL',
      [id],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async findByUsername(username: string): Promise<Student | null> {
    const [rows] = await this.pool.execute<StudentRow[]>(
      'SELECT * FROM students WHERE username = ? AND deleted_at IS NULL',
      [username],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async create(data: {
    parentId: number;
    username: string;
    passwordHash: string;
    name: string;
    age?: number;
    grade?: string;
    schoolLevel?: string;
  }): Promise<number> {
    const [result] = await this.pool.execute(
      `INSERT INTO students (parent_id, username, password_hash, name, age, grade, school_level)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.parentId, data.username, data.passwordHash, data.name,
       data.age ?? null, data.grade ?? null, data.schoolLevel ?? null],
    );
    return (result as any).insertId;
  }

  /** 家长控制台列表：自己名下、未软删的学生，按创建时间倒序。 */
  async findByParentId(parentId: number): Promise<Student[]> {
    const [rows] = await this.pool.execute<StudentRow[]>(
      'SELECT * FROM students WHERE parent_id = ? AND deleted_at IS NULL ORDER BY id DESC',
      [parentId],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async updatePassword(id: number, passwordHash: string): Promise<void> {
    await this.pool.execute(
      'UPDATE students SET password_hash = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
      [passwordHash, id],
    );
  }

  async setActive(id: number, isActive: boolean): Promise<void> {
    await this.pool.execute(
      'UPDATE students SET is_active = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
      [isActive ? 1 : 0, id],
    );
  }

  /** 新建子账号时连带建默认 student_settings（school 随学段）。 */
  async createDefaultSettings(studentId: number, schoolLevel: string): Promise<void> {
    await this.pool.execute(
      'INSERT INTO student_settings (student_id, school) VALUES (?, ?) ON DUPLICATE KEY UPDATE school = VALUES(school)',
      [studentId, schoolLevel],
    );
  }

  private mapRow(row: StudentRow): Student {
    return {
      id: row.id,
      parentId: row.parent_id,
      username: row.username,
      passwordHash: row.password_hash,
      name: row.name,
      age: row.age,
      grade: row.grade,
      schoolLevel: row.school_level,
      isActive: row.is_active === 1,
    };
  }
}
