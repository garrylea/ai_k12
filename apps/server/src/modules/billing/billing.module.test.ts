import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { BillingModule } from './billing.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { QuotaController } from './quota.controller.js';
import { BillingController } from './billing.controller.js';
import { BillingCallbackController } from './billing-callback.controller.js';
import { AdminBillingController } from './admin-billing.controller.js';
import { SubscriptionsService } from './subscriptions.service.js';
import { BillingService } from './billing.service.js';
import { OrdersRepository } from '../../database/repositories/orders.repo.js';
import { FamilySubscriptionsRepository } from '../../database/repositories/family-subscriptions.repo.js';
import { SubscriptionPlansRepository } from '../../database/repositories/subscription-plans.repo.js';

/**
 * 模块装配钉子：钉住 QuotaController 挂在 BillingModule 的 `controllers` 里、
 * 且整条 DI 链（controller → service → 两个 repo → DATABASE_POOL）能从容器解析。
 *
 * 背景：quota.controller.ts 曾存在且单测全绿，但没注册进任何 module 的
 * `controllers` 数组 —— 运行时 GET /api/quota/subscription 静默 404，
 * 路由形状测试（quota.controller.test.ts）抓不到「没装配」这一层。
 *
 * 不起 HTTP 服务：createNestApplication + init() 只装配容器、不 listen。
 * DatabaseModule 一并 import（与生产 wiring 一致），其 DATABASE_POOL 覆盖为 `{}`：
 * 真工厂会 createPool() 连 MySQL，构造阶段只存引用用不到 pool，覆盖掉即可。
 */
describe('BillingModule 装配', () => {
  /**
   * vitest 的 esbuild 转换**不发** `design:paramtypes`（生产 tsc 的
   * emitDecoratorMetadata: true 才发；本仓其它类参数靠这个元数据注入）。
   * 不补的话 Nest 拿不到参数类型、静默注入 undefined，装配断言失真。
   * 这里手工补上（与 tsc 产出等价），让容器真实解析：
   * controller 没注册进 `controllers`、或 service/repo 不在 `providers` 里时，
   * 下面的用例照样会红 —— 钉子有效性不受影响。
   */
  Reflect.defineMetadata('design:paramtypes', [SubscriptionsService], QuotaController);
  Reflect.defineMetadata(
    'design:paramtypes',
    [FamilySubscriptionsRepository],
    SubscriptionsService,
  );
  // 批② Task 5 的三个 controller：constructor 参数都是类类型，同样手工补 metadata
  Reflect.defineMetadata('design:paramtypes', [BillingService, SubscriptionsService], BillingController);
  Reflect.defineMetadata('design:paramtypes', [BillingService], BillingCallbackController);
  Reflect.defineMetadata('design:paramtypes', [BillingService], AdminBillingController);

  const apps: INestApplication[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function compileApp() {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, BillingModule],
    })
      // 生产里 DatabaseModule 的工厂会 createPool()；测试把 DATABASE_POOL 覆盖为
      // `{}`（构造阶段只存引用，不会真的用到 pool）。
      .overrideProvider('DATABASE_POOL')
      .useValue({})
      .compile();
    const app = moduleRef.createNestApplication();
    apps.push(app);
    await app.init();
    return app;
  }

  it('QuotaController 挂在模块上，能从容器解析（漏注册 controllers 时此用例必红）', async () => {
    const app = await compileApp();
    expect(app.get(QuotaController)).toBeInstanceOf(QuotaController);
  });

  it('整条 provider 链可解析：service 与两个仓储都在容器里', async () => {
    const app = await compileApp();
    expect(app.get(SubscriptionsService)).toBeInstanceOf(SubscriptionsService);
    expect(app.get(FamilySubscriptionsRepository)).toBeInstanceOf(FamilySubscriptionsRepository);
    expect(app.get(SubscriptionPlansRepository)).toBeInstanceOf(SubscriptionPlansRepository);
  });

  it('批②：BillingService / OrdersRepository 可解析（BillingService 全部依赖显式 @Inject，不靠 design:paramtypes）', async () => {
    const app = await compileApp();
    expect(app.get(BillingService)).toBeInstanceOf(BillingService);
    expect(app.get(OrdersRepository)).toBeInstanceOf(OrdersRepository);
    const svc = app.get(BillingService) as unknown as Record<string, unknown>;
    expect(svc.ordersRepo).toBeInstanceOf(OrdersRepository);
    expect(svc.subscriptionsService).toBeInstanceOf(SubscriptionsService);
    expect(svc.wechatAdapter).toBeInstanceOf(Object); // useFactory 构造的三适配器都已注入
    expect(svc.alipayAdapter).toBeInstanceOf(Object);
    expect(svc.mockAdapter).toBeInstanceOf(Object);
  });

  it('controller 的 service 依赖由容器注入（同一单例，不是游离实例）', async () => {
    const app = await compileApp();
    const controller = app.get(QuotaController);
    const service = app.get(SubscriptionsService);
    expect((controller as unknown as { subscriptionsService: SubscriptionsService }).subscriptionsService).toBe(
      service,
    );
  });

  it('批② Task 5：三组 billing controller 都挂在模块上，能从容器解析（漏注册 controllers 时此用例必红）', async () => {
    const app = await compileApp();
    expect(app.get(BillingController)).toBeInstanceOf(BillingController);
    expect(app.get(BillingCallbackController)).toBeInstanceOf(BillingCallbackController);
    expect(app.get(AdminBillingController)).toBeInstanceOf(AdminBillingController);
    const billing = app.get(BillingController) as unknown as Record<string, unknown>;
    expect(billing.billingService).toBeInstanceOf(BillingService);
    expect(billing.subscriptionsService).toBeInstanceOf(SubscriptionsService);
  });
});
