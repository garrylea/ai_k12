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

/** 命令在 pending 里最长存活多久（分钟）。超时即 `expired`，见 `pollAndConsume`。 */
export const COMMAND_TTL_MINUTES = 10;

export interface PollResult {
  commands: Array<{ id: number; command: string }>;
  openSession: LearningSessionRow | null;
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

  /** 按 id + 归属学生读一行。**不是自己的 → null**，由服务层翻成 404/1002。 */
  async findByIdForStudent(id: number, studentId: number): Promise<LearningSessionRow | null> {
    const [rows] = await this.pool.execute<LearningSessionRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM learning_sessions WHERE id = ? AND student_id = ? LIMIT 1`,
      [id, studentId],
    );
    return rows[0] ?? null;
  }

  /** 结束指定 id 的会话（带 studentId 双重约束，防止越权结束别人的）。 */
  async endById(id: number, studentId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE learning_sessions SET ended_at = NOW(3)
       WHERE id = ? AND student_id = ? AND ended_at IS NULL`,
      [id, studentId],
    );
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

  /**
   * 家长端「进出时间」列表：窗口内按开始时间倒序。
   *
   * ⚠️ **必须 `pool.query`（客户端转义）而不是 `pool.execute`**：MySQL 对预处理语句的
   * `LIMIT ?` 直接报 `Incorrect arguments to mysqld_stmt_execute`（SQL 字符串本身完全正确、参数顺序也对）。
   * 全仓护栏见 `limit-placeholder.guard.test.ts`；2026-09-20 `GET /api/parent/alerts` 每调必 500
   * 就是这个形态，而当时全部仓储用例是绿的（mockPool 从不真执行 SQL）。
   */
  async listByStudent(
    studentId: number,
    since: Date,
    limit: number,
  ): Promise<LearningSessionRow[]> {
    const [rows] = await this.pool.query<LearningSessionRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM learning_sessions
       WHERE student_id = ? AND started_at >= ?
       ORDER BY started_at DESC LIMIT ?`,
      [studentId, since, limit],
    );
    return rows;
  }

  /** 同窗口的总数（不受 limit 影响，供分页/提示）。 */
  async countByStudent(studentId: number, since: Date): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(*) AS total FROM learning_sessions WHERE student_id = ? AND started_at >= ?`,
      [studentId, since],
    );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * 学生端一次轮询的全部副作用（spec §5.3），**同一个事务**：
   *   1. 惰性过期：把超时的 pending 命令置 expired；
   *   2. 心跳：刷新进行中会话的 last_seen_at（轮询兼心跳，判「在线」的唯一依据）；
   *   3. 取 pending 命令；
   *   4. 认领（consumed）：`WHERE status='pending'` 让认领幂等；
   *   5. `unlock` → 把进行中会话的 unlocked_at / unlocked_by_parent_id 落库。
   *
   * 为什么要事务：4 与 5 必须同生共死——认领了命令却没落 unlocked_at，家长端会显示
   * 「已下发但没生效」，而学生端已经解锁了。
   *
   * 为什么惰性过期而不是定时任务：一条陈旧 unlock 会解锁**将来某次**锁定。过期只是兜底，
   * 主防线是服务端「没有进行中会话就 409，不许下发」（spec §5.4）。
   */
  async pollAndConsume(studentId: number): Promise<PollResult> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.execute(
        `UPDATE device_commands SET status = 'expired'
         WHERE student_id = ? AND status = 'pending'
           AND created_at < DATE_SUB(NOW(3), INTERVAL ${COMMAND_TTL_MINUTES} MINUTE)`,
        [studentId],
      );

      await conn.execute(
        `UPDATE learning_sessions SET last_seen_at = NOW(3)
         WHERE student_id = ? AND ended_at IS NULL`,
        [studentId],
      );

      const [pending] = await conn.execute<
        (RowDataPacket & { id: number; command: string; issued_by_parent_id: number })[]
      >(
        `SELECT id, command, issued_by_parent_id FROM device_commands
         WHERE student_id = ? AND status = 'pending' ORDER BY id`,
        [studentId],
      );

      if (pending.length > 0) {
        const placeholders = pending.map(() => '?').join(', ');
        await conn.execute(
          `UPDATE device_commands SET status = 'consumed', consumed_at = NOW(3)
           WHERE id IN (${placeholders}) AND status = 'pending'`,
          pending.map((row) => row.id),
        );

        const unlock = pending.find((row) => row.command === 'unlock');
        if (unlock) {
          await conn.execute(
            `UPDATE learning_sessions SET unlocked_at = NOW(3), unlocked_by_parent_id = ?
             WHERE student_id = ? AND ended_at IS NULL`,
            [unlock.issued_by_parent_id, studentId],
          );
        }
      }

      const [sessions] = await conn.execute<LearningSessionRow[]>(
        `SELECT ${SELECT_COLUMNS} FROM learning_sessions
         WHERE student_id = ? AND ended_at IS NULL LIMIT 1`,
        [studentId],
      );

      await conn.commit();
      return {
        commands: pending.map((row) => ({ id: row.id, command: row.command })),
        openSession: sessions[0] ?? null,
      };
    } catch (err) {
      // 回滚失败（连接已断）不能顶掉真正的失败原因；吞掉回滚错误，向上抛原始 err
      try {
        await conn.rollback();
      } catch {
        /* 保留原始错误 */
      }
      throw err;
    } finally {
      conn.release();
    }
  }
}
