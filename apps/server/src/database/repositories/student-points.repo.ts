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
   * 用行别名（`AS new`）而非已弃用的 `VALUES()`：MySQL 8.0.20 起后者会打弃用告警
   * （同 `student-word-progress.repo.ts:60`）。增量算术因此写成
   * `student_points.col + new.col`——左侧必须带表名限定，否则被别名 `new` 遮蔽。
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
       VALUES (?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE total_earned = student_points.total_earned + new.total_earned, balance = student_points.balance + new.balance`;
    const params = [studentId, earnedDelta, balanceDelta];
    if (conn) {
      await conn.execute(sql, params);
      return;
    }
    await this.pool.execute(sql, params);
  }

  /**
   * 条件扣减余额：仅当余额足够时才扣，返回 `affectedRows`（0 = 余额不足，未扣任何分）。
   *
   * 兑换的余额校验**必须**走这里，不能先读后写——两次并发兑换都会读到同一个够用的余额、
   * 双双通过检查，再用无条件的 `balance = balance + delta` 把 `balance` 扣成负数
   * （`student_points.balance` 是有符号 INT、无 CHECK 兜底，`schema.sql` 拦不住）。
   * 条件 UPDATE 在同一事务内由 InnoDB 行锁串行化：只有一方 `affectedRows = 1`。
   *
   * **只 `SET balance`，SQL 里不出现 `total_earned`**（等价于 `earnedDelta` 恒为 0）：
   * 兑换绝不能动 `total_earned`，否则段位会降（「段位只升不降」见 `redemption.service.ts` 类注释）。
   */
  async deductBalanceIfEnough(
    studentId: number,
    points: number,
    conn?: PoolConnection,
  ): Promise<number> {
    const sql = `UPDATE student_points SET balance = balance - ? WHERE student_id = ? AND balance >= ?`;
    const params = [points, studentId, points];
    const [result] = conn
      ? await conn.execute<ResultSetHeader>(sql, params)
      : await this.pool.execute<ResultSetHeader>(sql, params);
    return result.affectedRows;
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

  /**
   * 重建脚本用：用流水重算结果**覆盖**快照（不做增量）。
   *
   * 同样用行别名 `AS new` 而非已弃用的 `VALUES()`（MySQL 8.0.20 起后者打弃用告警）。
   */
  async overwrite(studentId: number, totalEarned: number, balance: number): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO student_points (student_id, total_earned, balance)
       VALUES (?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE total_earned = new.total_earned, balance = new.balance`,
      [studentId, totalEarned, balance],
    );
  }
}
