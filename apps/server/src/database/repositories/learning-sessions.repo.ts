import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/** `learning_sessions` 一行（spec §4.2）。`ended_at IS NULL` = 进行中。 */
export interface LearningSessionRow extends RowDataPacket {
  id: number;
  student_id: number;
  app_shell: string;
  started_at: Date;
  last_seen_at: Date;
  ended_at: Date | null;
  lock_minutes: number | null;
  lock_expires_at: Date | null;
  unlocked_at: Date | null;
  unlocked_by_parent_id: number | null;
}

export interface InsertOpenInput {
  studentId: number;
  appShell: string;
  lockMinutes: number | null;
}

const SELECT_COLUMNS =
  'id, student_id, app_shell, started_at, last_seen_at, ended_at, lock_minutes, lock_expires_at, unlocked_at, unlocked_by_parent_id';

/** MySQL 唯一键冲突。 */
const ER_DUP_ENTRY = 1062;

/**
 * 一次学习会话（spec §4.2）。
 *
 * 「一个学生同时只有一个进行中的会话」由 **DB 层**唯一键 `uniq_lsessions_active`
 * （条件式 VIRTUAL 生成列 `active_student_id`）保证，**不是** check-then-insert。
 * 因此本仓储的 `insertOpen` 必须处理撞键：回读既有行返回，而不是抛错。
 */
@Injectable()
export class LearningSessionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 找该生**进行中**的会话。无则 null。 */
  async findOpen(studentId: number): Promise<LearningSessionRow | null> {
    const [rows] = await this.pool.execute<LearningSessionRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM learning_sessions
       WHERE student_id = ? AND ended_at IS NULL LIMIT 1`,
      [studentId],
    );
    return rows[0] ?? null;
  }

  /**
   * 新建一条进行中的会话。**撞唯一键（1062）= 已有进行中会话** → 回读并返回那一行。
   *
   * 返回既有行而不是抛错，是「重启不重置时钟」的关键：客户端重启后再调取或建，
   * 会拿到**原来那个** `lock_expires_at`，而不是一个新的一小时。
   *
   * `lock_expires_at` 非 null 时用 SQL 侧 `NOW(3)` 算，避免应用与 DB 时钟不一致。
   *
   * ⚠️ **占位符个数必须恒为 4、与参数数组逐位对应**：mysql2 的 `execute` 走服务端预处理，
   * 参数是**按位置**绑定的。曾经写成「未设锁时把 `lock_expires_at` 拼成字面 `NULL`」→
   * 语句只有 3 个 `?` 但传了 2 个参数，服务端直接报
   * `Incorrect arguments to COM_STMT_EXECUTE`（2026-09-24 实测，四种写法逐一试过）。
   * 所以 `null` 也要**当作参数传**，不要拼进 SQL 文本。
   */
  async insertOpen(input: InsertOpenInput): Promise<LearningSessionRow> {
    // 未设锁 → 该列就是 NULL；设了锁 → 由 DB 侧时钟算，避免应用与 DB 时钟不一致。
    const expiresFragment =
      input.lockMinutes === null ? '?' : 'DATE_ADD(NOW(3), INTERVAL ? MINUTE)';
    const params: Array<number | string | null> = [
      input.studentId,
      input.appShell,
      input.lockMinutes,
      input.lockMinutes,
    ];

    try {
      const [result] = await this.pool.execute<ResultSetHeader>(
        `INSERT INTO learning_sessions (student_id, app_shell, lock_minutes, lock_expires_at)
         VALUES (?, ?, ?, ${expiresFragment})`,
        params,
      );
      const row = await this.findById(result.insertId);
      if (!row) throw new Error(`learning_sessions ${result.insertId} 插入后读不到`);
      return row;
    } catch (err) {
      if ((err as { errno?: number }).errno === ER_DUP_ENTRY) {
        const existing = await this.findOpen(input.studentId);
        if (existing) return existing;
      }
      throw err;
    }
  }

  /** 按 id 读一行（不限学生）。 */
  async findById(id: number): Promise<LearningSessionRow | null> {
    const [rows] = await this.pool.execute<LearningSessionRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM learning_sessions WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** 刷新「最后一次见到客户端」。轮询端点每 10 秒调一次，兼作心跳。 */
  async touch(studentId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE learning_sessions SET last_seen_at = NOW(3)
       WHERE student_id = ? AND ended_at IS NULL`,
      [studentId],
    );
  }

  /** 结束该生的进行中会话（幂等：没有进行中的行时影响 0 行，调用方不需要区分）。 */
  async endOpen(studentId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE learning_sessions SET ended_at = NOW(3)
       WHERE student_id = ? AND ended_at IS NULL`,
      [studentId],
    );
  }
}
