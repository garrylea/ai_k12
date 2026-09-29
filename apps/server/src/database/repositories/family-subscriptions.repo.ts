import { Injectable, Inject } from '@nestjs/common';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

export interface FamilySubscriptionTimes {
  trial_ends_at: Date | null;
  current_period_end: Date | null;
}

interface TimesRow extends RowDataPacket, FamilySubscriptionTimes {}

/**
 * 家庭订阅（`family_subscriptions`，UNIQUE parent_id —— 一个家庭一行）。
 *
 * `status` / `plan_code` / `source` 是冗余展示列，业务口径以 `effectiveStatus`
 * 纯函数推导为准（见 billing/subscription-status.ts），本仓储只负责按调用方
 * 语义同步写这些列。
 */
@Injectable()
export class FamilySubscriptionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findByParentId(parentId: number): Promise<FamilySubscriptionTimes | null> {
    const [rows] = await this.pool.execute<TimesRow[]>(
      `SELECT trial_ends_at, current_period_end FROM family_subscriptions WHERE parent_id = ?`,
      [parentId],
    );
    return rows[0] ?? null;
  }

  /** 经 students 表按学生反查其家庭的订阅时间（学生端闸口用）。 */
  async findByStudentId(studentId: number): Promise<FamilySubscriptionTimes | null> {
    const [rows] = await this.pool.execute<TimesRow[]>(
      `SELECT fs.trial_ends_at, fs.current_period_end
         FROM students st
         JOIN family_subscriptions fs ON fs.parent_id = st.parent_id
        WHERE st.id = ?`,
      [studentId],
    );
    return rows[0] ?? null;
  }

  /**
   * 兜底补行（如存量家长首次触达时补试用行）：行已存在则**什么都不改**
   * （`ON DUPLICATE KEY UPDATE id = id`），绝不覆盖已有 trial/period 数据。
   *
   * @param conn 可选：调用方事务内执行时传入。
   */
  async upsertTrial(parentId: number, trialEndsAt: Date, conn?: PoolConnection): Promise<void> {
    await (conn ?? this.pool).execute(
      `INSERT INTO family_subscriptions (parent_id, status, trial_ends_at, source)
       VALUES (?, 'trialing', ?, 'trial')
       ON DUPLICATE KEY UPDATE id = id`,
      [parentId, trialEndsAt],
    );
  }

  /**
   * 付费续期——调用方事务内执行（与订单置 paid 同生共死）。
   * 行锁 + 「期内顺延 / 过期从 now 起算」；同步写冗余 status/plan_code/source。
   * 注意：锁与读必须走同一 conn（FOR UPDATE 读到的是锁窗口内的行，事务外 pool 读会绕开锁语义）。
   */
  async renewWithinTx(
    conn: PoolConnection,
    parentId: number,
    planCode: string,
    durationDays: number,
    now: Date,
  ): Promise<{ currentPeriodEnd: Date }> {
    const [locked] = await conn.execute<RowDataPacket[]>(
      `SELECT current_period_end FROM family_subscriptions WHERE parent_id = ? FOR UPDATE`,
      [parentId],
    );
    const currentEnd = (locked[0]?.current_period_end as Date | undefined) ?? null;
    const base = currentEnd != null && currentEnd.getTime() > now.getTime() ? currentEnd : now;
    const end = new Date(base.getTime() + durationDays * 86_400_000);
    if (locked.length === 0) {
      // 行不存在（异常态：付费时无行）——补偿插入
      await conn.execute(
        `INSERT INTO family_subscriptions (parent_id, status, current_period_end, plan_code, source)
         VALUES (?, 'active', ?, ?, 'order')`,
        [parentId, end, planCode],
      );
      return { currentPeriodEnd: end };
    }
    await conn.execute(
      `UPDATE family_subscriptions
          SET current_period_end = ?, status = 'active', plan_code = ?, source = 'order'
        WHERE parent_id = ?`,
      [end, planCode, parentId],
    );
    return { currentPeriodEnd: end };
  }
}
