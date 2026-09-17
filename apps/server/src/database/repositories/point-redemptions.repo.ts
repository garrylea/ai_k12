import { Injectable, Inject } from '@nestjs/common';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface PointRedemptionRow extends RowDataPacket {
  id: number;
  student_id: number;
  type: 'cash' | 'reward';
  points_spent: number;
  /** DECIMAL(10,2)：mysql2 默认按字符串返回，映射成 number 是服务层的事。 */
  cash_amount: string | number | null;
  reward_catalog_id: number | null;
  reward_name: string | null;
  status: 'pending' | 'fulfilled';
  note: string | null;
  ledger_id: number | null;
  created_at: Date;
  fulfilled_at: Date | null;
}

export interface PointRedemptionInsertInput {
  student_id: number;
  type: 'cash' | 'reward';
  points_spent: number;
  cash_amount?: number | null;
  reward_catalog_id?: number | null;
  reward_name?: string | null;
  note?: string | null;
}

/**
 * 兑换单（`point_redemptions`）。`cash_amount` / `reward_name` 都是**快照**：
 * catalog 改名或下架不影响历史兑换单。
 *
 * **本期兑换不可撤销**：`status` 只有 pending/fulfilled 两个值，`updateStatus` 只写
 * `status` + `fulfilled_at`，**从不碰积分**（没有任何回补流水的代码路径）。
 *
 * ⚠️ `ledger_id` 是随后回写的（先插兑换单拿到自增 id，才能拼 `redeem:<id>` 这个 dedupe_key），
 * 因此插入兑换单时它必然为 NULL，由 `setLedgerId` 在同一事务里补上。
 */
@Injectable()
export class PointRedemptionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 落一条 pending 兑换单，返回自增 id。`status` 写死 'pending'（走 DDL 默认值也一样，这里显式）。 */
  async insert(input: PointRedemptionInsertInput, conn?: PoolConnection): Promise<number> {
    const [result] = await (conn ?? this.pool).execute<ResultSetHeader>(
      `INSERT INTO point_redemptions
         (student_id, type, points_spent, cash_amount, reward_catalog_id, reward_name, note, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        input.student_id,
        input.type,
        input.points_spent,
        input.cash_amount ?? null,
        input.reward_catalog_id ?? null,
        input.reward_name ?? null,
        input.note ?? null,
      ],
    );
    return result.insertId;
  }

  /**
   * 回写流水 id，返回 `affectedRows`（0 = 兑换单不存在/不属于该生 → 调用方视为数据异常）。
   *
   * @param conn 必须传：回写是兑换事务的一部分，不回写就不能提交。
   */
  async setLedgerId(
    studentId: number,
    id: number,
    ledgerId: number,
    conn?: PoolConnection,
  ): Promise<number> {
    const [result] = await (conn ?? this.pool).execute<ResultSetHeader>(
      `UPDATE point_redemptions SET ledger_id = ? WHERE student_id = ? AND id = ?`,
      [ledgerId, studentId, id],
    );
    return result.affectedRows;
  }

  async findOne(studentId: number, id: number): Promise<PointRedemptionRow | null> {
    const [rows] = await this.pool.execute<PointRedemptionRow[]>(
      `SELECT * FROM point_redemptions WHERE student_id = ? AND id = ? LIMIT 1`,
      [studentId, id],
    );
    return rows[0] ?? null;
  }

  /**
   * 按主键反查（**不带 student_id 过滤**）。
   *
   * 只服务「路径里没有 studentId、必须先知道它属于谁」的端点——
   * `PATCH /api/parent/redemptions/:id`（spec §7.3）。归属判定**不在这一层**：拿回行后由
   * `RedemptionService` / `requireOwnedStudent` 决定，查到别人的行不是泄漏（调用方会 403）。
   */
  async findById(id: number): Promise<PointRedemptionRow | null> {
    const [rows] = await this.pool.execute<PointRedemptionRow[]>(
      `SELECT * FROM point_redemptions WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * 分页（id 倒序，最新在前）。用池 `query`（客户端转义）而非 `execute`：MySQL 对预处理语句的
   * `LIMIT ?` 报 "Incorrect arguments to mysqld_stmt_execute"（同 `point-ledger.repo.ts`）。
   */
  async listByStudent(studentId: number, limit: number, offset: number): Promise<PointRedemptionRow[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM point_redemptions
        WHERE student_id = ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
      [studentId, limit, offset],
    );
    return rows as PointRedemptionRow[];
  }

  async countByStudent(studentId: number): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { count: number })[]>(
      `SELECT COUNT(*) AS count FROM point_redemptions WHERE student_id = ?`,
      [studentId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * 只改状态，返回 `affectedRows`；0 = 兑换单不存在/不属于该生。
   *
   * **绝不碰积分**：兑换不可撤销，此处没有、也不该有回补流水的逻辑。`fulfilled_at` 由调用方
   * 按服务器时间算好传参（pending 传 null），不在 SQL 里用 `NOW()`——与全仓「时间在应用层算」的口径一致。
   */
  async updateStatus(
    studentId: number,
    id: number,
    status: 'pending' | 'fulfilled',
    fulfilledAt: Date | null,
    conn?: PoolConnection,
  ): Promise<number> {
    const [result] = await (conn ?? this.pool).execute<ResultSetHeader>(
      `UPDATE point_redemptions SET status = ?, fulfilled_at = ? WHERE student_id = ? AND id = ?`,
      [status, fulfilledAt, studentId, id],
    );
    return result.affectedRows;
  }
}
