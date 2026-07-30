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
    };
  }
}
