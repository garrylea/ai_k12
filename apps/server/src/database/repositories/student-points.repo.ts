import { Injectable, Inject } from '@nestjs/common';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface StudentPointsSnapshot {
  totalEarned: number;
  balance: number;
}

/**
 * 积分快照仓储（`student_points`，读优化，**可重建**）。
 *
 * - `total_earned` 单调递增（只加 `kind='earn'` 的分），「段位只升不降」是它的必然结果。
 * - `balance` 可减（兑换写负流水）。两者与流水**同事务**更新，坏了由重建脚本从流水重算。
 * - 新学生**没有行**，直到第一次发分才 `upsertDelta` 建行；`find` 因此对无行返回全 0 而不是抛错。
 */
@Injectable()
export class StudentPointsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 增量更新快照（无行则建行）。调用方与流水插入放同一事务时传 `conn`。
   *
   * `VALUES()` 形式按本任务契约钉死（`total_earned = total_earned + VALUES(total_earned)`），
   * 与 `student-word-progress.repo.ts` 用的行别名 `AS new` 写法不同——勿「统一」掉，
   * 测试与 Task 4 都按该 SQL 形状断言。
   *
   * @param earnedDelta 只加 `total_earned`（兑换传 0）
   * @param balanceDelta 同时加到 `balance`（兑换传负数）
   */
  async upsertDelta(
    studentId: number,
    earnedDelta: number,
    balanceDelta: number,
    conn?: PoolConnection,
  ): Promise<void> {
    const sql = `INSERT INTO student_points (student_id, total_earned, balance)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE total_earned = total_earned + VALUES(total_earned), balance = balance + VALUES(balance)`;
    const params = [studentId, earnedDelta, balanceDelta];
    if (conn) {
      await conn.execute(sql, params);
      return;
    }
    await this.pool.execute(sql, params);
  }

  /** 无行（新学生还没发过分）时返回 `{ totalEarned: 0, balance: 0 }`，不抛错、不返回 null。 */
  async find(studentId: number): Promise<StudentPointsSnapshot> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT total_earned, balance FROM student_points WHERE student_id = ? LIMIT 1`,
      [studentId],
    );
    const row = rows[0] as { total_earned: number; balance: number } | undefined;
    return {
      totalEarned: Number(row?.total_earned ?? 0),
      balance: Number(row?.balance ?? 0),
    };
  }

  /** 重建脚本用：用流水重算结果**覆盖**快照（不做增量）。 */
  async overwrite(studentId: number, totalEarned: number, balance: number): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO student_points (student_id, total_earned, balance)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE total_earned = VALUES(total_earned), balance = VALUES(balance)`,
      [studentId, totalEarned, balance],
    );
  }
}
