import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { QuotaController } from './quota.controller.js';
import type { SubscriptionsService } from './subscriptions.service.js';
import type { StatusView } from './subscriptions.service.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';

/**
 * Nest 的元数据常量值。`@nestjs/common` 没从包入口导出这些字符串
 * （内部在 `@nestjs/common/constants`），这里用字面量 + 用例钉住，防装饰器被误删。
 * 同款写法见 `admin.controller.test.ts:21`。
 */
const GUARDS_METADATA = '__guards__';
const METHOD_METADATA = 'method';
const PATH_METADATA = 'path';

/** service 全 mock，不连库。 */
function makeController(
  service: Partial<Record<'getStatusView' | 'listPlans' | 'getUsageView', ReturnType<typeof vi.fn>>>,
) {
  return new QuotaController(service as unknown as SubscriptionsService);
}

const STUB_VIEW: StatusView = {
  status: 'trialing',
  planCode: null,
  trialEndsAt: '2026-10-06T00:00:00.000Z',
  currentPeriodEnd: null,
  daysRemaining: 7,
  source: 'trial',
};

describe('QuotaController 路由形状', () => {
  it('GET /subscription 挂在类前缀 api/quota 下，方法是 GET（200，非 @Post 的 201）', () => {
    expect(Reflect.getMetadata(PATH_METADATA, QuotaController)).toBe('api/quota');
    expect(Reflect.getMetadata(PATH_METADATA, QuotaController.prototype.getSubscription)).toBe(
      'subscription',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, QuotaController.prototype.getSubscription)).toBe(
      RequestMethod.GET,
    );
  });

  it('类上挂 JwtAuthGuard + RolesGuard（读端点也不得绕过鉴权）', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, QuotaController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));
  });

  it('GET /plans：方法 GET、路径 plans，handler 上无 @Roles（三角色可读）', () => {
    const handler = QuotaController.prototype.listPlans;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('plans');
    expect(new Reflector().get<string[] | undefined>('roles', handler)).toBeUndefined();
  });

  it('GET /usage：方法 GET、路径 plans 之外独立路径，handler 级 @Roles(parent)（学生 403）', () => {
    const handler = QuotaController.prototype.getUsage;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('usage');
    // 类上无 @Roles（否则连坐 /subscription、/plans），角色限定只挂在这个 handler 上
    expect(new Reflector().get<string[] | undefined>('roles', QuotaController)).toBeUndefined();
    expect(new Reflector().get<string[]>('roles', handler)).toEqual(['parent']);
  });

  it('角色不设限（类级）：/subscription 与 /plans 对 student/parent/admin 都可读', () => {
    const roles = new Reflector().get<string[] | undefined>('roles', QuotaController);
    expect(roles).toBeUndefined();
  });
});

describe('QuotaController 委派', () => {
  it('student 请求：把 JWT 身份 {role:"student", sub} 原样交给 service，返回值透传', async () => {
    const getStatusView = vi.fn().mockResolvedValue(STUB_VIEW);
    const controller = makeController({ getStatusView });
    const user: JwtUser = { sub: 42, role: 'student', familyId: 7, parentId: 7 };

    await expect(controller.getSubscription(user)).resolves.toBe(STUB_VIEW);
    expect(getStatusView).toHaveBeenCalledTimes(1);
    expect(getStatusView).toHaveBeenCalledWith({ sub: 42, role: 'student', familyId: 7, parentId: 7 });
  });

  it('parent 请求：同一入口按自身查，不做任何二次加工', async () => {
    const getStatusView = vi.fn().mockResolvedValue(STUB_VIEW);
    const controller = makeController({ getStatusView });
    const user: JwtUser = { sub: 7, role: 'parent' };

    await expect(controller.getSubscription(user)).resolves.toBe(STUB_VIEW);
    expect(getStatusView).toHaveBeenCalledWith({ sub: 7, role: 'parent' });
  });

  it('GET /plans：无参透传 listPlans()，返回值原样', async () => {
    const listPlans = vi.fn().mockResolvedValue([
      { planCode: 'month', name: '月度会员', priceCents: 19800, durationDays: 30 },
    ]);
    const controller = makeController({ listPlans });

    await expect(controller.listPlans()).resolves.toEqual([
      { planCode: 'month', name: '月度会员', priceCents: 19800, durationDays: 30 },
    ]);
    expect(listPlans).toHaveBeenCalledWith();
  });

  it('GET /usage：家长 JWT sub 即 parent_id 透传 getUsageView（角色拦截在 RolesGuard，handler 不重复判）', async () => {
    const usage = { periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', calls: 5 };
    const getUsageView = vi.fn().mockResolvedValue(usage);
    const controller = makeController({ getUsageView });
    const user: JwtUser = { sub: 7, role: 'parent' };

    await expect(controller.getUsage(user)).resolves.toBe(usage);
    expect(getUsageView).toHaveBeenCalledWith(7);
  });
});
