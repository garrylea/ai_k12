import { Module } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service.js';
import { FamilySubscriptionsRepository } from '../../database/repositories/family-subscriptions.repo.js';
import { SubscriptionPlansRepository } from '../../database/repositories/subscription-plans.repo.js';

/**
 * 订阅收费模块（批①）。
 *
 * - `providers`：`SubscriptionsService` + 其依赖的两个仓储（跟随 points.module 的惯例：
 *   仓储逐个注册为 provider，`@Inject('DATABASE_POOL')` 由全局 DatabaseModule 提供，
 *   这里不需要 import 它）。
 * - `exports`：`SubscriptionsService`（AuthModule 的注册送试用钩子、批② 的 finalize 事务
 *   都要注入）与两个仓储（批② 的订单/支付模块直接复用，避免重复注册两个实例）。
 */
@Module({
  providers: [SubscriptionsService, FamilySubscriptionsRepository, SubscriptionPlansRepository],
  exports: [SubscriptionsService, FamilySubscriptionsRepository, SubscriptionPlansRepository],
})
export class BillingModule {}
