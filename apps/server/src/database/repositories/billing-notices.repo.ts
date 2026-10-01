import { Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export type BillingNoticeType = 'claim_approved' | 'claim_rejected';

export interface BillingNoticeRow extends RowDataPacket {
  id: number; parent_id: number; type: BillingNoticeType; order_no: string;
  reason: string | null; is_read: number; created_at: Date; updated_at: Date;
}

/**
 * 裁决结果通知（`billing_notices`，批④验收缺陷修复）：admin approve/reject 裁决
 * 及自动闭环迁移发生时落一条站内通知，家长端可见。只写 insert 在 BillingService
 * 裁决链路；读/已读三个方法由家长端通知端点消费（批④ Task 3/4）。
 */
@Injectable()
export class BillingNoticesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async insert(input: { parentId: number; type: BillingNoticeType; orderNo: string; reason: string | null }): Promise<void> {
    await this.pool.execute(
      `INSERT INTO billing_notices (parent_id, type, order_no, reason) VALUES (?, ?, ?, ?)`,
      [input.parentId, input.type, input.orderNo, input.reason],
    );
  }

  /** LIMIT 用字面量（仓规：不走 `LIMIT ?` 占位符）。 */
  async listUnread(parentId: number): Promise<BillingNoticeRow[]> {
    const [rows] = await this.pool.query<BillingNoticeRow[]>(
      `SELECT id, parent_id, type, order_no, reason, is_read, created_at, updated_at
         FROM billing_notices WHERE parent_id = ? AND is_read = 0 ORDER BY id DESC LIMIT 50`,
      [parentId],
    );
    return rows;
  }

  async findById(id: number): Promise<BillingNoticeRow | null> {
    const [rows] = await this.pool.execute<BillingNoticeRow[]>(
      `SELECT id, parent_id, type, order_no, reason, is_read, created_at, updated_at FROM billing_notices WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  async markRead(id: number, parentId: number): Promise<void> {
    await this.pool.execute(`UPDATE billing_notices SET is_read = 1 WHERE id = ? AND parent_id = ?`, [id, parentId]);
  }
}
