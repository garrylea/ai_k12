import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/** 7 个 module 值（与 special_practice_logs.module + math/physics/chemistry_targeted）。 */
export type SpecialSessionModule =
  | 'chinese_dictation' | 'chinese_interpretation' | 'chinese_meaning'
  | 'en_vocabulary' | 'math_targeted' | 'physics_targeted' | 'chemistry_targeted';

export interface UpsertSessionInput {
  sessionUid: string;
  studentId: number;
  subjectId: number;
  module: SpecialSessionModule;
  title: string | null;
  questionCount: number;
}

export interface SessionListRow {
  id: number;
  session_uid: string;
  student_id: number;
  subject_id: number;
  module: SpecialSessionModule;
  title: string | null;
  question_count: number;
  started_at: Date;
  completed_at: Date | null;
}

@Injectable()
export class SpecialPracticeSessionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 惰性建会话：INSERT IGNORE，首次返回 insertId；命中已存在行（affectedRows=0）时
   * 再 SELECT 取 id。返回 session id 供后续 upsertAnswer 用。
   */
  async upsertSession(input: UpsertSessionInput): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO special_practice_sessions
       (session_uid, student_id, subject_id, module, title, question_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.sessionUid, input.studentId, input.subjectId, input.module, input.title, input.questionCount],
    );
    if (result.insertId > 0) return result.insertId;
    // 命中已存在行：按 uid 取 id
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id FROM special_practice_sessions WHERE session_uid = ?`,
      [input.sessionUid],
    );
    return (rows[0] as { id: number }).id;
  }

  /** 标记完成（前端离开时调用，可选）。 */
  async markCompleted(sessionId: number, studentId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE special_practice_sessions SET completed_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND student_id = ? AND completed_at IS NULL`,
      [sessionId, studentId],
    );
  }

  /** 列表查询（按学生，可选学科筛选）。 */
  async listByStudent(
    studentId: number,
    opts: { subjectId?: number; limit?: number; offset?: number },
  ): Promise<SessionListRow[]> {
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    const where = opts.subjectId
      ? `WHERE student_id = ? AND subject_id = ?`
      : `WHERE student_id = ?`;
    const params = opts.subjectId ? [studentId, opts.subjectId, limit, offset] : [studentId, limit, offset];
    // 走 pool.query（客户端转义）：mysql2 对 execute 的 LIMIT ? 占位符会直接报 ER_WRONG_ARGUMENTS。
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM special_practice_sessions ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      params,
    );
    return rows as SessionListRow[];
  }

  /** 总数（分页用）。 */
  async countByStudent(studentId: number, subjectId?: number): Promise<number> {
    const where = subjectId ? `WHERE student_id = ? AND subject_id = ?` : `WHERE student_id = ?`;
    const params = subjectId ? [studentId, subjectId] : [studentId];
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM special_practice_sessions ${where}`,
      params,
    );
    return Number((rows[0] as { cnt: number | string }).cnt ?? 0);
  }

  /** 单个 session 归属校验（防 IDOR）。 */
  async findByIdOwned(sessionId: number, studentId: number): Promise<SessionListRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM special_practice_sessions WHERE id = ? AND student_id = ?`,
      [sessionId, studentId],
    );
    return (rows[0] as SessionListRow) ?? null;
  }
}
