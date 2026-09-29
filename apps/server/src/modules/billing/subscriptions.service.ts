import { Injectable } from '@nestjs/common';
import type { PoolConnection } from 'mysql2/promise';
import { FamilySubscriptionsRepository } from '../../database/repositories/family-subscriptions.repo.js';
import { effectiveStatus, daysRemaining } from './subscription-status.js';
import type { SubscriptionStatus } from './subscription-status.js';
import { TRIAL_DAYS } from './billing.config.js';

export interface StatusView {
  status: SubscriptionStatus;
  planCode: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  daysRemaining: number;
  source: string;
}

export interface StatusViewer {
  role: 'student' | 'parent' | 'admin';
  sub: number;
}

@Injectable()
export class SubscriptionsService {
  constructor(private readonly subsRepo: FamilySubscriptionsRepository) {}

  /**
   * 注册送试用：`now + TRIAL_DAYS`，upsert 幂等（行已存在则什么都不改，
   * 绝不覆盖已有 trial/period 数据）。失败向外抛，让注册可见地失败 ——
   * 保证「注册成功 ⇒ 试用行已存在」。
   */
  async ensureTrial(parentId: number): Promise<void> {
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86_400_000);
    await this.subsRepo.upsertTrial(parentId, trialEndsAt);
  }

  /**
   * 订阅状态视图（三角色统一口径）。学生按学生反查家庭，家长/管理员按自身查。
   * Date → ISO 字符串序列化，DTO 不裸露 Date。
   */
  async getStatusView(viewer: StatusViewer): Promise<StatusView> {
    const times =
      viewer.role === 'student'
        ? await this.subsRepo.findByStudentId(viewer.sub)
        : await this.subsRepo.findByParentId(viewer.sub);

    const trialEndsAt = times?.trial_ends_at ?? null;
    const currentPeriodEnd = times?.current_period_end ?? null;
    const now = new Date();
    const status = effectiveStatus(now, { trialEndsAt, currentPeriodEnd });

    // 仓储只回时间两列、不回 source 冗余列，按口径推导：
    // 有付费期（current_period_end 非空）→ 'order'，否则一律 'trial'（含无行 expired）。
    const source = currentPeriodEnd != null ? 'order' : 'trial';

    const remaining =
      status === 'active' && currentPeriodEnd != null
        ? daysRemaining(now, currentPeriodEnd)
        : status === 'trialing' && trialEndsAt != null
          ? daysRemaining(now, trialEndsAt)
          : 0;

    return {
      status,
      // 仓储当前只读 trial_ends_at / current_period_end 两列，plan_code 未取
      // （trial / 无行场景本就是 null；付费态的 planCode 由批②带 plan 的查询补齐）。
      planCode: null,
      trialEndsAt: trialEndsAt != null ? trialEndsAt.toISOString() : null,
      currentPeriodEnd: currentPeriodEnd != null ? currentPeriodEnd.toISOString() : null,
      daysRemaining: remaining,
      source,
    };
  }

  /**
   * 付费续期——透传 repo，批② 的 finalize 事务调用（与订单置 paid 同生共死）。
   * now 由 service 统一注入，调用方不必传时钟。
   */
  async renewWithinTx(
    conn: PoolConnection,
    parentId: number,
    planCode: string,
    durationDays: number,
  ): Promise<{ currentPeriodEnd: Date }> {
    return this.subsRepo.renewWithinTx(conn, parentId, planCode, durationDays, new Date());
  }
}
