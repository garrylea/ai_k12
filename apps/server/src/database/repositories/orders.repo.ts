import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export type OrderPaymentStatus = 'pending' | 'paid' | 'cancelled' | 'expired';

/**
 * 订单裁决（claim）状态（批④ Task 3）：NULL = 家长从未主张过「我已付款」。
 * pending_review（confirm-paid 查单未确认时落）→ approved（真实入账后自动闭环 / admin 通过）| rejected（admin 驳回）。
 */
export type OrderClaimStatus = 'pending_review' | 'approved' | 'rejected';

/**
 * `plan_snapshot` JSON 列的形状（下单时的套餐快照：目录改名/调价/下架不影响历史订单）。
 * finalize 事务从这里取 planCode/durationDays，不回查套餐表（套餐可能已下架）。
 */
export interface OrderPlanSnapshot {
  planCode: string;
  name: string;
  priceCents: number;
  durationDays: number;
}

export interface OrderRow extends RowDataPacket {
  id: number;
  order_no: string;
  parent_id: number;
  plan_id: number;
  /** JSON 列：mysql2 默认返回已解析对象（老驱动/某些配置可能给字符串，读取统一走 parseOrderSnapshot）。 */
  plan_snapshot: OrderPlanSnapshot;
  amount_cents: number;
  payment_status: OrderPaymentStatus;
  channel: string;
  channel_trade_no: string | null;
  channel_qr_content: string | null;
  paid_at: Date | null;
  cancelled_at: Date | null;
  expires_at: Date;
  claim_status: OrderClaimStatus | null;
  claimed_at: Date | null;
  claim_note: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrderInsertInput {
  orderNo: string;
  parentId: number;
  planId: number;
  planSnapshot: OrderPlanSnapshot;
  amountCents: number;
  channel: string;
  expiresAt: Date;
}

/** 快照读取：兼容 JSON 列返回对象 / 字符串两种形态。 */
export function parseOrderSnapshot(raw: OrderRow['plan_snapshot']): OrderPlanSnapshot {
  if (typeof raw === 'string') return JSON.parse(raw) as OrderPlanSnapshot;
  return raw;
}

/**
 * 订单（`orders`，schema 见 tools/db/schema.sql）。
 *
 * - `payment_status` 状态机：pending → paid | cancelled | expired；paid 为唯一入账终态，
 *   `markPaidTx` 用 `WHERE ... AND payment_status IN ('pending','expired')` 的原子条件更新兜住并发
 *   （回调 / confirm-paid / admin mark-paid 三方竞态时只有一个赢家；expired 放行是
 *   2026-09-30 用户裁决——真实回调晚到照常入账，cancelled 仍被 service 层拒绝）。
 * - 超时时长 `ORDER_PENDING_TTL_MINUTES`（billing.config，2h）由 BillingService 在下单时
 *   算好 `expires_at` 写入；本仓储不读 config，保持纯 SQL 层。
 * - 时间一律应用层传参，不在 SQL 里用 NOW()（与 point-redemptions.repo 同一口径）。
 */
@Injectable()
export class OrdersRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async insertOrder(input: OrderInsertInput): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO orders
         (order_no, parent_id, plan_id, plan_snapshot, amount_cents, payment_status, channel, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        input.orderNo,
        input.parentId,
        input.planId,
        JSON.stringify(input.planSnapshot),
        input.amountCents,
        input.channel,
        input.expiresAt,
      ],
    );
    return result.insertId;
  }

  async findByOrderNo(orderNo: string): Promise<OrderRow | null> {
    const [rows] = await this.pool.execute<OrderRow[]>(
      `SELECT * FROM orders WHERE order_no = ? LIMIT 1`,
      [orderNo],
    );
    return rows[0] ?? null;
  }

  /** 该家长最新的 pending 单（防串单判断用：一个家长同时至多一张进行中的单）。 */
  async findPendingByParent(parentId: number): Promise<OrderRow | null> {
    const [rows] = await this.pool.execute<OrderRow[]>(
      `SELECT * FROM orders
        WHERE parent_id = ? AND payment_status = 'pending'
        ORDER BY id DESC LIMIT 1`,
      [parentId],
    );
    return rows[0] ?? null;
  }

  /**
   * 分页（id 倒序，最新在前）。用池 `query`（客户端转义）而非 `execute`：MySQL 对预处理
   * 语句的 `LIMIT ?` 报 "Incorrect arguments to mysqld_stmt_execute"（全仓护栏
   * `limit-placeholder.guard.test.ts` 钉的就是这个坑）。
   */
  async listByParent(parentId: number, page: number, pageSize: number) {
    const offset = (page - 1) * pageSize;
    const [[cntRows], [rows]] = await Promise.all([
      this.pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM orders WHERE parent_id = ?`, [parentId]),
      this.pool.query<RowDataPacket[]>(
        `SELECT * FROM orders WHERE parent_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
        [parentId, pageSize, offset],
      ),
    ]);
    return { total: Number(cntRows[0].total), rows: rows as OrderRow[] };
  }

  /**
   * 惰性过期：pending 且 `expires_at` 已过 → expired。单条 UPDATE 天然幂等
   * （再跑一次影响 0 行），由读路径（getOrder/listOrders/confirmPaid）入口调用。
   */
  async expireStale(now: Date = new Date()): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE orders SET payment_status = 'expired'
        WHERE payment_status = 'pending' AND expires_at < ?`,
      [now],
    );
    return result.affectedRows;
  }

  /**
   * 事务内置 paid：`WHERE payment_status IN ('pending','expired')` 是并发赢家判定 ——
   * 影响行 0 = 已被其他路径终态化，调用方必须 ROLLBACK 返回 duplicate，绝不重复续期。
   * 放行 expired（2026-09-30 用户裁决）：真实渠道回调晚到（家长付了钱但订单已被惰性
   * 翻转 expired）时照常入账、订阅顺延；cancelled 仍被 service 层闸门拒绝，到不了这里。
   *
   * @param conn 必须传：与 BEGIN/COMMIT 同一连接（brief Step 2 事务骨架）。
   */
  async markPaidTx(conn: PoolConnection, orderId: number, tradeNo: string, paidAt: Date): Promise<number> {
    const [result] = await conn.execute<ResultSetHeader>(
      `UPDATE orders SET payment_status = 'paid', channel_trade_no = ?, paid_at = ?
        WHERE id = ? AND payment_status IN ('pending', 'expired')`,
      [tradeNo, paidAt, orderId],
    );
    return result.affectedRows;
  }

  /** 下单成功后回写渠道返回（微信 Native 下单不回交易号 → tradeNo 可为 null，等回调/查单回填）。 */
  async setChannelResult(orderId: number, tradeNo: string | null, qrContent: string | null): Promise<void> {
    await this.pool.execute(
      `UPDATE orders SET channel_trade_no = ?, channel_qr_content = ? WHERE id = ?`,
      [tradeNo, qrContent, orderId],
    );
  }

  /** 取消：只翻 pending（原子条件，影响 0 = 已被并发终态化）。不调渠道关单 API（2h 超时兜底）。 */
  async cancelPending(orderId: number, cancelledAt: Date): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE orders SET payment_status = 'cancelled', cancelled_at = ?
        WHERE id = ? AND payment_status = 'pending'`,
      [cancelledAt, orderId],
    );
    return result.affectedRows;
  }

  /**
   * claim 读写（批④ Task 3）：`status` 必写；`note` 传 undefined = 不动 claim_note
   * （传 null = 置 NULL，本仓链路不会用到）；`claimedAt` 传 undefined = 不动 claimed_at
   * （只有落 pending_review 时由调用方传时间刷新——重复 confirm 幂等刷新时间戳）。
   */
  async markClaim(
    orderId: number,
    status: OrderClaimStatus,
    note?: string | null,
    claimedAt?: Date,
  ): Promise<void> {
    const sets: string[] = ['claim_status = ?'];
    const params: (string | Date | number | null)[] = [status];
    if (note !== undefined) {
      sets.push('claim_note = ?');
      params.push(note);
    }
    if (claimedAt !== undefined) {
      sets.push('claimed_at = ?');
      params.push(claimedAt);
    }
    params.push(orderId);
    await this.pool.execute<ResultSetHeader>(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  /**
   * admin 待裁决列表（批④ Task 3）：claim_status 过滤 + claimed_at 倒序（最新主张在前），
   * JOIN parents 取手机号（admin 复核联系方式用）。分页用池 `query`（`LIMIT ?` 坑，
   * 同 {@link OrdersRepository.listByParent}）。
   */
  async findClaims(status: OrderClaimStatus, page: number, pageSize: number) {
    const offset = (page - 1) * pageSize;
    const [[cntRows], [rows]] = await Promise.all([
      this.pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM orders WHERE claim_status = ?`, [status]),
      this.pool.query<RowDataPacket[]>(
        `SELECT o.*, p.phone AS parent_phone
           FROM orders o JOIN parents p ON p.id = o.parent_id
          WHERE o.claim_status = ?
          ORDER BY o.claimed_at DESC, o.id DESC
          LIMIT ? OFFSET ?`,
        [status, pageSize, offset],
      ),
    ]);
    return { total: Number(cntRows[0].total), rows: rows as (OrderRow & { parent_phone: string })[] };
  }
}
