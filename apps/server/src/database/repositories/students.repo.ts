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
  grade_updated_at: Date | null;
  created_at: Date;
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
  /** 上次年级/年龄校准时间；登录时按它推算该升几级（见 grade.ts advanceGradeOnLogin） */
  gradeUpdatedAt: Date | null;
  createdAt: Date;
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
      `INSERT INTO students (parent_id, username, password_hash, name, age, grade, school_level, grade_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
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

  /** 管理台搜索：用户名/姓名模糊。 */
  async search(q: string): Promise<Student[]> {
    const like = `%${q}%`;
    const [rows] = await this.pool.execute<StudentRow[]>(
      'SELECT * FROM students WHERE deleted_at IS NULL AND (username LIKE ? OR name LIKE ?) ORDER BY id DESC LIMIT 50',
      [like, like]);
    return rows.map((r) => this.mapRow(r));
  }

  /** 启动重建封禁名单用：所有停用（未软删）学生。 */
  async listInactive(): Promise<Student[]> {
    const [rows] = await this.pool.execute<StudentRow[]>(
      'SELECT * FROM students WHERE is_active = 0 AND deleted_at IS NULL',
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

  /**
   * 家长端编辑孩子档案（姓名/年龄/年级）。
   * 只要动了年级或年龄，就把 `grade_updated_at` 重置为当下——否则下次登录会拿旧基准
   * 再算一遍，刚改的年级立刻又被自动推进。
   */
  async updateProfile(
    id: number,
    data: { name?: string; age?: number; grade?: string; schoolLevel?: string },
  ): Promise<void> {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (data.name !== undefined) {
      sets.push('name = ?');
      params.push(data.name);
    }
    if (data.age !== undefined) {
      sets.push('age = ?');
      params.push(data.age);
    }
    if (data.grade !== undefined) {
      sets.push('grade = ?');
      params.push(data.grade);
    }
    if (data.schoolLevel !== undefined) {
      sets.push('school_level = ?');
      params.push(data.schoolLevel);
    }
    if (sets.length === 0) return;
    if (data.age !== undefined || data.grade !== undefined) {
      sets.push('grade_updated_at = CURRENT_TIMESTAMP(3)');
    }
    sets.push('updated_at = CURRENT_TIMESTAMP(3)');
    params.push(id);
    await this.pool.execute(`UPDATE students SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  /**
   * 登录时的年级/年龄校准写回（grade.ts advanceGradeOnLogin 的结果）。
   * 只在年级或年龄真的变了时调用——没变还写会把基准日往后推，漏掉下一次开学。
   */
  async syncGrade(
    id: number,
    data: { grade: string; schoolLevel: string; age: number },
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE students
          SET grade = ?, school_level = ?, age = ?,
              grade_updated_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = ?`,
      [data.grade, data.schoolLevel, data.age, id],
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
      gradeUpdatedAt: row.grade_updated_at ?? null,
      createdAt: row.created_at,
      isActive: row.is_active === 1,
    };
  }
}
