import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface PointLedgerRow extends RowDataPacket {
  id: number;
  student_id: number;
  kind: 'earn' | 'redeem';
  task_code: string;
  tier_key: string;
  points: number;
  dedupe_key: string;
  title: string;
  ref_type: string | null;
  ref_id: number | null;
  redemption_id: number | null;
  created_at: Date;
}

/** 落一条流水所需的最小字段；`tier_key` 缺省写 'default'，其余可空字段缺省写 NULL。 */
export interface PointLedgerInsertInput {
  student_id: number;
  kind: 'earn' | 'redeem';
  task_code: string;
  tier_key?: string;
  points: number;
  dedupe_key: string;
  title: string;
  ref_type?: string | null;
  ref_id?: number | null;
  redemption_id?: number | null;
}

/**
 * 积分流水仓储。`point_ledger` 是积分的**唯一真源**（段位与 student_points 快照都由它算）。
 *
 * 幂等靠 `uniq_point_ledger_dedupe`：`INSERT IGNORE` 撞键即「已发过」，不报错、不重复加分；
 * 调用方拿 `duplicate: true` 后用 `findByDedupeKey` 回查**首次**的 points 返回（`title` 也是快照，
 * 家长后来改分值不影响历史流水）。
 */
@Injectable()
export class PointLedgerRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 幂等插入一条流水。
   *
   * `duplicate = affectedRows === 0`（撞 dedupe_key）。
   * ⚠️ 重复路径下返回的 `id` 来自 `insertId`，**不是**既有那行的 id（MySQL 在 INSERT IGNORE
   * 跳过时不会给出命中的行 id）。调用方必须用 `findByDedupeKey` 回查首次结果，别拿这个 id 当流水主键。
   */
  async insert(row: PointLedgerInsertInput): Promise<{ id: number; duplicate: boolean }> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO point_ledger
         (student_id, kind, task_code, tier_key, points, dedupe_key, title, ref_type, ref_id, redemption_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.student_id,
        row.kind,
        row.task_code,
        row.tier_key ?? 'default',
        row.points,
        row.dedupe_key,
        row.title,
        row.ref_type ?? null,
        row.ref_id ?? null,
        row.redemption_id ?? null,
      ],
    );
    return { id: result.insertId, duplicate: result.affectedRows === 0 };
  }

  async findByDedupeKey(dedupeKey: string): Promise<PointLedgerRow | null> {
    const [rows] = await this.pool.execute<PointLedgerRow[]>(
      `SELECT * FROM point_ledger WHERE dedupe_key = ? LIMIT 1`,
      [dedupeKey],
    );
    return rows[0] ?? null;
  }

  /**
   * 今日该任务已发分的**条数**——每日上限的统一口径（spec §6.3：一轮/一篇/一个会话各算 1 条）。
   *
   * `dayStart` / `dayEnd` 由**应用层**按服务器本地时区算好传参（当日 00:00 / 次日 00:00），
   * 刻意不在 SQL 里用 `CURDATE()`——DB 会话时区与应用可能不一致，会算错一天（见 spec §4.4 与
   * `student-word-progress.repo.ts` 的既有约定）。`dayEnd` 用 `<` 半开区间，跨月/跨年无需拼接。
   */
  async countTodayEarned(
    studentId: number,
    taskCode: string,
    dayStart: Date,
    dayEnd: Date,
  ): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { count: number })[]>(
      `SELECT COUNT(*) AS count FROM point_ledger
       WHERE student_id = ? AND task_code = ? AND kind = 'earn'
         AND created_at >= ? AND created_at < ?`,
      [studentId, taskCode, dayStart, dayEnd],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** 累计**获得**（`kind='earn'`）——段位依据。重建脚本用。 */
  async sumEarned(studentId: number): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { total: number | string })[]>(
      `SELECT COALESCE(SUM(points), 0) AS total FROM point_ledger
       WHERE student_id = ? AND kind = 'earn'`,
      [studentId],
    );
    return Number(rows[0]?.total ?? 0);
  }

  /** 全部流水求和（earn 正 + redeem 负）——可用余额。重建脚本用。 */
  async sumAll(studentId: number): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { total: number | string })[]>(
      `SELECT COALESCE(SUM(points), 0) AS total FROM point_ledger WHERE student_id = ?`,
      [studentId],
    );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * 学生端/家长端流水分页（按 id 倒序，最新在前）。
   *
   * 用池 `query`（客户端转义）而非 `execute`（服务端预处理）：MySQL 对预处理语句的 `LIMIT ?`
   * 报 "Incorrect arguments to mysqld_stmt_execute"。值仍经 mysql2 转义，无注入风险。
   */
  async listByStudent(studentId: number, limit: number, offset: number): Promise<PointLedgerRow[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM point_ledger
       WHERE student_id = ?
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [studentId, limit, offset],
    );
    return rows as PointLedgerRow[];
  }

  async countByStudent(studentId: number): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { count: number })[]>(
      `SELECT COUNT(*) AS count FROM point_ledger WHERE student_id = ?`,
      [studentId],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
