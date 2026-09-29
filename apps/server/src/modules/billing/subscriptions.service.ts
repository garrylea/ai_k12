import { Injectable } from '@nestjs/common';
import type { PoolConnection } from 'mysql2/promise';
import { FamilySubscriptionsRepository } from '../../database/repositories/family-subscriptions.repo.js';
import { SubscriptionPlansRepository } from '../../database/repositories/subscription-plans.repo.js';
import { LlmUsageRepository } from '../../database/repositories/llm-usage.repo.js';
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

export interface PlanView {
  planCode: string;
  name: string;
  priceCents: number;
  durationDays: number;
}

export interface UsageDayView {
  date: string;
  calls: number;
  tokens: number;
}

export interface UsageView {
  periodStart: string;
  periodEnd: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  tokensUnknown: number;
  byDay: UsageDayView[];
}

/** 用量统计窗口：rolling 30 天近似（见 getUsageView 注释）。 */
const USAGE_WINDOW_DAYS = 30;

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly subsRepo: FamilySubscriptionsRepository,
    private readonly plansRepo: SubscriptionPlansRepository,
    private readonly usageRepo: LlmUsageRepository,
  ) {}

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
      planCode: times?.plan_code ?? null,
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

  /** 在售套餐目录（active 过滤在 repo 侧，service 只做 snake_case → camelCase 映射）。 */
  async listPlans(): Promise<PlanView[]> {
    const rows = await this.plansRepo.listActive();
    return rows.map((r) => ({
      planCode: r.plan_code,
      name: r.name,
      priceCents: Number(r.price_cents),
      durationDays: Number(r.duration_days),
    }));
  }

  /**
   * AI 用量聚合视图（仅家长；controller 侧 @Roles('parent') 把学生挡在 403）。
   *
   * 口径（批③ PRD 注记同文）：
   * - `periodEnd = currentPeriodEnd ?? now`（orders 未存 period_start，spec §5.1
   *   的「当前订阅周期」以下条近似落地）；
   * - `periodStart = periodEnd - 30 天` —— **rolling 30 天，不按订阅周期起算**；
   * - 聚合范围 = 该家长名下**所有学生**（repo 侧 JOIN students）；
   * - `tokensUnknown` 独立计数（NULL = 量不到，绝不按 0 混入）；
   * - `byDay` 只回有数据日，`tokens = input + output`（单日 SUM 全 NULL 按 0
   *   参与该和，不影响 tokensUnknown）。
   */
  async getUsageView(parentId: number): Promise<UsageView> {
    const times = await this.subsRepo.findByParentId(parentId);
    const periodEnd = times?.current_period_end ?? new Date();
    const periodStart = new Date(periodEnd.getTime() - USAGE_WINDOW_DAYS * 86_400_000);

    const rows = await this.usageRepo.aggregateByDay(parentId, periodStart, periodEnd);

    let calls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let tokensUnknown = 0;
    const byDay = rows.map((r) => {
      const dayCalls = Number(r.calls);
      // 单日 SUM 全 NULL → mysql2 回 null：tokens 按 0 参与求和，不碰 tokensUnknown
      const inTok = r.input_tokens == null ? 0 : Number(r.input_tokens);
      const outTok = r.output_tokens == null ? 0 : Number(r.output_tokens);
      calls += dayCalls;
      inputTokens += inTok;
      outputTokens += outTok;
      tokensUnknown += Number(r.tokens_unknown);
      return { date: r.day, calls: dayCalls, tokens: inTok + outTok };
    });

    return {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      calls,
      inputTokens,
      outputTokens,
      tokensUnknown,
      byDay,
    };
  }
}
