import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolConnection } from 'mysql2/promise';

/** `subscription_adjustments.type`：服务端白名单（迁移注释同文：单取值不用死枚举列）。 */
export type AdjustmentType = 'trial_set' | 'grant_days';

export interface AdjustmentInput {
  parentId: number;
  /** 操作管理员（JWT sub）；无外键，管理账号删除不丢审计。 */
  adminId: number;
  type: AdjustmentType;
  /** type=trial_set 时有值：改写后的试用截止（null=收回）。 */
  trialEndsAt: Date | null;
  /** type=grant_days 时有值：追加天数（负数=扣减）。 */
  deltaDays: number | null;
  reason: string | null;
}

/**
 * 管理端订阅调整审计流水（批④ Task 5，`subscription_adjustments`）。
 * 只有写没有读——本期消费方是人工对账（运营 SQL），不设查询端点。
 */
@Injectable()
export class SubscriptionAdjustmentsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 落一行审计。`conn` 由调用方传入时与业务写同事务（同生共死——审计缺失即整笔回滚，
   * 「adjustments 每次操作落一行」由事务原子性保证），不传则在池上独立执行。
   */
  async insert(input: AdjustmentInput, conn?: PoolConnection): Promise<void> {
    await (conn ?? this.pool).execute(
      `INSERT INTO subscription_adjustments (parent_id, admin_id, type, trial_ends_at, delta_days, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.parentId, input.adminId, input.type, input.trialEndsAt, input.deltaDays, input.reason],
    );
  }
}
