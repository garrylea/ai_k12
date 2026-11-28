import { HttpException, Injectable, Inject, Logger } from '@nestjs/common';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

function isMissingFeaturedColumnError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return e.code === 'ER_BAD_FIELD_ERROR'
    && typeof e.message === 'string'
    && e.message.includes('featured_publication_id');
}

/** 专项会话 module 值：语文三专项 + 英语背单词 + 各学科 targeted（英语/道法已补齐）。 */
export type SpecialSessionModule =
  | 'chinese_dictation' | 'chinese_interpretation' | 'chinese_meaning'
  | 'en_vocabulary' | 'cn_targeted' | 'en_targeted'
  | 'math_targeted' | 'physics_targeted' | 'chemistry_targeted' | 'politics_targeted';

export interface UpsertSessionInput {
  sessionUid: string;
  studentId: number;
  subjectId: number;
  module: SpecialSessionModule;
  title: string | null;
  questionCount: number;
  /** 服务端 open 创建的精选题会话归属；普通专项会话不传（写 NULL）。 */
  featuredPublicationId?: number | null;
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
  private readonly logger = new Logger(SpecialPracticeSessionsRepository.name);
  private warnedMissingFeaturedColumn = false;

  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 惰性建会话：INSERT IGNORE，首次返回 insertId；命中已存在行（affectedRows=0）时
   * 再 SELECT 取 id。返回 session id 供后续 upsertAnswer 用。
   */
  async upsertSession(input: UpsertSessionInput, executor?: PoolConnection): Promise<number> {
    const db = executor ?? this.pool;
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT IGNORE INTO special_practice_sessions
       (session_uid, student_id, subject_id, module, title, question_count, featured_publication_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sessionUid, input.studentId, input.subjectId, input.module, input.title, input.questionCount,
        input.featuredPublicationId ?? null,
      ],
    );
    if (result.insertId > 0) return result.insertId;
    // 命中已存在行：session_uid 是客户端提供的全局唯一键，必须核对归属与场景，
    // 否则学生 A 带学生 B 的 uid 会把答案写进 B 的会话（IDOR，spec §3 硬约束 6）。
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT id, student_id, subject_id, module FROM special_practice_sessions WHERE session_uid = ?`,
      [input.sessionUid],
    );
    const row = rows[0] as {
      id: number; student_id: number; subject_id: number; module: string;
    } | undefined;
    if (
      !row || Number(row.student_id) !== input.studentId ||
      Number(row.subject_id) !== input.subjectId || row.module !== input.module
    ) {
      throw new HttpException({ code: 1002, message: '会话标识冲突' }, 409);
    }
    return row.id;
  }

  /** 标记完成（前端离开时调用，可选）。 */
  async markCompleted(sessionId: number, studentId: number, executor?: PoolConnection): Promise<void> {
    const db = executor ?? this.pool;
    await db.execute(
      `UPDATE special_practice_sessions SET completed_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND student_id = ? AND completed_at IS NULL`,
      [sessionId, studentId],
    );
  }

  /**
   * 按 session_uid + student_id 标记完成（结算/完成端点用）。
   * 返回 affectedRows：0 表示会话不存在、非本人或已完成。
   */
  async markCompletedByUid(sessionUid: string, studentId: number, executor?: PoolConnection): Promise<number> {
    const db = executor ?? this.pool;
    const [r] = await db.execute<ResultSetHeader>(
      `UPDATE special_practice_sessions SET completed_at = NOW(3)
       WHERE session_uid = ? AND student_id = ? AND completed_at IS NULL`,
      [sessionUid, studentId],
    );
    return r.affectedRows;
  }

  /** 列表查询（按学生，可选学科筛选）。 */
  async listByStudent(
    studentId: number,
    opts: { subjectId?: number; limit?: number; offset?: number },
    executor?: PoolConnection,
  ): Promise<SessionListRow[]> {
    const db = executor ?? this.pool;
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    const where = opts.subjectId
      ? `WHERE student_id = ? AND subject_id = ?`
      : `WHERE student_id = ?`;
    const params = opts.subjectId ? [studentId, opts.subjectId, limit, offset] : [studentId, limit, offset];
    // 走 db.query（客户端转义）：mysql2 对 execute 的 LIMIT ? 占位符会直接报 ER_WRONG_ARGUMENTS。
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT * FROM special_practice_sessions ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      params,
    );
    return rows as SessionListRow[];
  }

  /** 总数（分页用）。 */
  async countByStudent(studentId: number, subjectId?: number, executor?: PoolConnection): Promise<number> {
    const db = executor ?? this.pool;
    const where = subjectId ? `WHERE student_id = ? AND subject_id = ?` : `WHERE student_id = ?`;
    const params = subjectId ? [studentId, subjectId] : [studentId];
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM special_practice_sessions ${where}`,
      params,
    );
    return Number((rows[0] as { cnt: number | string }).cnt ?? 0);
  }

  /**
   * 结算入口按 session_uid + student_id 定位会话 id（归属校验防 IDOR）。
   * 事务内传 executor；无行（含非本人）抛 409/1002，避免把别人的作答当自己的结算。
   */
  async findIdByUid(sessionUid: string, studentId: number, executor?: PoolConnection): Promise<number> {
    const db = executor ?? this.pool;
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT id FROM special_practice_sessions WHERE session_uid = ? AND student_id = ?`,
      [sessionUid, studentId],
    );
    const id = (rows[0] as { id?: number })?.id;
    if (!id) throw new HttpException({ code: 1002, message: '作答记录不存在或已失效，请重新提交' }, 409);
    return id;
  }

  /**
   * 服务端判定会话是否为精选题会话（Task 7 硬约束：记历史但不发积分）。
   * 客户端传来的 suppressErrorFixPoints=false 不可信，判题前按 uid + student 查库定夺。
   */
  async isFeaturedSession(sessionUid: string, studentId: number): Promise<boolean> {
    try {
      const [rows] = await this.pool.execute<RowDataPacket[]>(
        `SELECT featured_publication_id
         FROM special_practice_sessions
        WHERE session_uid = ? AND student_id = ?`,
        [sessionUid, studentId],
      );
      return rows[0]?.featured_publication_id != null;
    } catch (err) {
      if (!isMissingFeaturedColumnError(err)) throw err;
      if (!this.warnedMissingFeaturedColumn) {
        this.warnedMissingFeaturedColumn = true;
        this.logger.warn('精选 schema 未迁移，判题按普通专项会话处理');
      }
      return false;
    }
  }

  /** 单个 session 归属校验（防 IDOR）。 */
  async findByIdOwned(sessionId: number, studentId: number, executor?: PoolConnection): Promise<SessionListRow | null> {
    const db = executor ?? this.pool;
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT * FROM special_practice_sessions WHERE id = ? AND student_id = ?`,
      [sessionId, studentId],
    );
    return (rows[0] as SessionListRow) ?? null;
  }
}
