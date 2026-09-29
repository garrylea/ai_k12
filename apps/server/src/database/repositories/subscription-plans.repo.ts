import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface SubscriptionPlanRow extends RowDataPacket {
  id: number;
  plan_code: string;
  name: string;
  price_cents: number;
  duration_days: number;
}

/** 套餐目录（`subscription_plans`），只读——套餐由迁移/运营维护，代码不写。 */
@Injectable()
export class SubscriptionPlansRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 全部在售套餐，按后台排序（月卡在前）。 */
  async listActive(): Promise<SubscriptionPlanRow[]> {
    const [rows] = await this.pool.execute<SubscriptionPlanRow[]>(
      `SELECT id, plan_code, name, price_cents, duration_days
         FROM subscription_plans
        WHERE is_active = 1
        ORDER BY sort_order, id`,
      [],
    );
    return rows;
  }

  /** 下架/不存在的 code 一律返回 null，由调用方按 404 处理。 */
  async findActiveByCode(planCode: string): Promise<SubscriptionPlanRow | null> {
    const [rows] = await this.pool.execute<SubscriptionPlanRow[]>(
      `SELECT id, plan_code, name, price_cents, duration_days
         FROM subscription_plans
        WHERE plan_code = ? AND is_active = 1
        LIMIT 1`,
      [planCode],
    );
    return rows[0] ?? null;
  }
}
