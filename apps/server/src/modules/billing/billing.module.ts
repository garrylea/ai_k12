import { Module } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service.js';
import { QuotaController } from './quota.controller.js';
import { BillingController } from './billing.controller.js';
import { BillingCallbackController } from './billing-callback.controller.js';
import { AdminBillingController } from './admin-billing.controller.js';
import { FamilySubscriptionsRepository } from '../../database/repositories/family-subscriptions.repo.js';
import { SubscriptionAdjustmentsRepository } from '../../database/repositories/subscription-adjustments.repo.js';
import { SubscriptionPlansRepository } from '../../database/repositories/subscription-plans.repo.js';
import { OrdersRepository } from '../../database/repositories/orders.repo.js';
import { LlmUsageRepository } from '../../database/repositories/llm-usage.repo.js';
import { BillingNoticesRepository } from '../../database/repositories/billing-notices.repo.js';
import { BillingService, WECHAT_PAY_ADAPTER, ALIPAY_PAY_ADAPTER, MOCK_PAY_ADAPTER } from './billing.service.js';
import { WechatNativePayAdapter } from './adapters/wechat-native-pay.adapter.js';
import { AlipayQrPayAdapter } from './adapters/alipay-qr-pay.adapter.js';
import { MockPayAdapter } from './adapters/mock-pay.adapter.js';

/**
 * 订阅收费模块（批① + 批②订单状态机）。
 *
 * - `providers`：`SubscriptionsService` / `BillingService` 及其仓储依赖（跟随 points.module
 *   的惯例：仓储逐个注册为 provider，`@Inject('DATABASE_POOL')` 由全局 DatabaseModule 提供，
 *   这里不需要 import 它）。
 * - 三个支付适配器**故意没有** @Injectable()（构造参数是原语/env，CLAUDE.md 的 DI 坑），
 *   用 useFactory 显式构造；选用开关（'mock' 仅 test/BILLING_USE_MOCK）在 BillingService。
 * - `exports`：`SubscriptionsService`（AuthModule 注册送试用钩子）与 `BillingService` /
 *   `OrdersRepository`（批③ 的 billing controller 消费），仓储复用避免重复注册实例。
 * - `controllers`：`QuotaController`（GET /api/quota/subscription + 批② /plans、/usage）
 *   + 批② 三组（BillingController / BillingCallbackController / AdminBillingController，
 *   漏注册端点会静默 404 —— `billing.module.test.ts` 有装配钉子）。
 */
@Module({
  controllers: [QuotaController, BillingController, BillingCallbackController, AdminBillingController],
  providers: [
    SubscriptionsService,
    FamilySubscriptionsRepository,
    SubscriptionAdjustmentsRepository,
    SubscriptionPlansRepository,
    OrdersRepository,
    LlmUsageRepository,
    BillingNoticesRepository, // 裁决结果通知仓储：仅 BillingService 内部消费，不进 exports
    { provide: WECHAT_PAY_ADAPTER, useFactory: () => new WechatNativePayAdapter() },
    { provide: ALIPAY_PAY_ADAPTER, useFactory: () => new AlipayQrPayAdapter() },
    { provide: MOCK_PAY_ADAPTER, useFactory: () => new MockPayAdapter(true) },
    BillingService,
  ],
  exports: [
    SubscriptionsService,
    FamilySubscriptionsRepository,
    SubscriptionPlansRepository,
    OrdersRepository,
    BillingService,
  ],
})
export class BillingModule {}
