import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RequestMethod, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { BillingController } from './billing.controller.js';
import { BillingCallbackController } from './billing-callback.controller.js';
import { AdminBillingController } from './admin-billing.controller.js';
import type { BillingService } from './billing.service.js';
import type { SubscriptionsService } from './subscriptions.service.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import type { OrderView } from './billing.service.js';

/**
 * Nest 的元数据常量值（@nestjs/common 不从包入口导出，字面量 + 用例钉住；
 * 同款写法见 quota.controller.test.ts）。注意 HTTP_CODE 是 `__httpCode__`。
 */
const GUARDS_METADATA = '__guards__';
const METHOD_METADATA = 'method';
const PATH_METADATA = 'path';
const HTTP_CODE_METADATA = '__httpCode__';

/** service 全 mock，不连库、不碰真实渠道。 */
function makeBillingController(
  service: Partial<Record<keyof BillingService, ReturnType<typeof vi.fn>>>,
  subsService: { getStatusView: ReturnType<typeof vi.fn> },
) {
  return new BillingController(service as unknown as BillingService, subsService as unknown as SubscriptionsService);
}

function makeCallbackController(handleCallback: ReturnType<typeof vi.fn>) {
  return new BillingCallbackController({ handleCallback } as unknown as BillingService);
}

function makeAdminController(adminMarkPaid: ReturnType<typeof vi.fn>) {
  return new AdminBillingController({ adminMarkPaid } as unknown as BillingService);
}

const PARENT: JwtUser = { sub: 7, role: 'parent' };

const STUB_VIEW: OrderView = {
  orderNo: 'ORD20260929120000000001',
  paymentStatus: 'pending',
  amountCents: 19800,
  planName: '月度会员',
  channel: 'wechat',
  createdAt: '2026-09-29T12:00:00.000Z',
  expiresAt: '2026-09-29T14:00:00.000Z',
  paidAt: null,
};

function mockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: vi.fn(),
  };
  return res as unknown as import('express').Response & {
    status: ReturnType<typeof vi.fn>;
    type: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
}

// 纯单元测试（无 DOM、无 HTTP 服务），不需要 testing-library cleanup。

describe('BillingController 路由形状', () => {
  it('挂在 api/billing 下，类上挂 JwtAuthGuard + RolesGuard + @Roles(parent)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BillingController)).toBe('api/billing');
    const guards = Reflect.getMetadata(GUARDS_METADATA, BillingController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));
    expect(new Reflector().get<string[]>('roles', BillingController)).toEqual(['parent']);
  });

  it('POST /orders 无 @HttpCode 覆盖 → Nest 默认 201（创建订单）', () => {
    const handler = BillingController.prototype.createOrder;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('orders');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBeUndefined();
  });

  it('cancel / confirm-paid 显式 @HttpCode(200)（状态迁移，不是创建）', () => {
    for (const handler of [BillingController.prototype.cancel, BillingController.prototype.confirmPaid]) {
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    }
    expect(Reflect.getMetadata(PATH_METADATA, BillingController.prototype.cancel)).toBe('orders/:orderNo/cancel');
    expect(Reflect.getMetadata(PATH_METADATA, BillingController.prototype.confirmPaid)).toBe(
      'orders/:orderNo/confirm-paid',
    );
  });
});

describe('BillingCallbackController 路由形状', () => {
  it('挂在 api/billing/callback 下，POST :channel 且 @HttpCode(200)（Nest @Post 默认 201，回调必须 200）', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BillingCallbackController)).toBe('api/billing/callback');
    const handler = BillingCallbackController.prototype.handleCallback;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':channel');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });

  it('免 JWT：类上不挂任何 guard、无 @Roles（渠道服务器不带我们的 token）', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, BillingCallbackController)).toBeUndefined();
    expect(new Reflector().get<string[] | undefined>('roles', BillingCallbackController)).toBeUndefined();
  });
});

describe('AdminBillingController 路由形状', () => {
  it('挂在 api/admin/billing 下，POST orders/:orderNo/mark-paid 且 @HttpCode(200)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminBillingController)).toBe('api/admin/billing');
    const handler = AdminBillingController.prototype.markPaid;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('orders/:orderNo/mark-paid');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });

  it('@Roles(admin)（家长/学生 token 打不进来）', () => {
    expect(new Reflector().get<string[]>('roles', AdminBillingController)).toEqual(['admin']);
  });
});

describe('BillingController 委派', () => {
  it('POST /orders：parentId 取自 JWT（不信 body），body 归一后透传，返回 OrderView 透传', async () => {
    const createOrder = vi.fn().mockResolvedValue(STUB_VIEW);
    const controller = makeBillingController({ createOrder }, { getStatusView: vi.fn() });

    await expect(
      controller.createOrder({ planCode: 'monthly', channel: 'wechat' }, PARENT),
    ).resolves.toBe(STUB_VIEW);
    expect(createOrder).toHaveBeenCalledWith(7, { planCode: 'monthly', channel: 'wechat' });
  });

  it('POST /orders：body 缺字段归一为空串（让 service 走 2005/1001，不落 SQL 500）', async () => {
    const createOrder = vi.fn().mockResolvedValue(STUB_VIEW);
    const controller = makeBillingController({ createOrder }, { getStatusView: vi.fn() });

    await controller.createOrder({}, PARENT);
    expect(createOrder).toHaveBeenCalledWith(7, { planCode: '', channel: '' });
  });

  it('GET /orders：page/pageSize string → number 透传（越界校验归 service，400/1001 不钳制）', async () => {
    const listOrders = vi.fn().mockResolvedValue({ items: [], total: 0, page: 3, pageSize: 50 });
    const controller = makeBillingController({ listOrders }, { getStatusView: vi.fn() });

    await controller.listOrders('3', '50', PARENT);
    expect(listOrders).toHaveBeenCalledWith(7, 3, 50);

    await controller.listOrders(undefined, undefined, PARENT);
    expect(listOrders).toHaveBeenLastCalledWith(7, undefined, undefined);

    await controller.listOrders('abc', '', PARENT);
    // Number('abc')=NaN、Number('')=0 —— 都过不了 service 的 Number.isInteger/≥1 校验（1001）
    expect(listOrders).toHaveBeenLastCalledWith(7, NaN, 0);
  });

  it('cancel：归属与状态校验全在 service，controller 只透传 (parentId, orderNo)', async () => {
    const cancel = vi.fn().mockResolvedValue({ ...STUB_VIEW, paymentStatus: 'cancelled' as const });
    const controller = makeBillingController({ cancel }, { getStatusView: vi.fn() });

    await controller.cancel('ORD1', PARENT);
    expect(cancel).toHaveBeenCalledWith(7, 'ORD1');
  });

  it('confirm-paid：service 的 paid/duplicate 都按已支付回，currentPeriodEnd 取自订阅状态视图', async () => {
    const confirmPaid = vi.fn().mockResolvedValue('paid');
    const getStatusView = vi.fn().mockResolvedValue({ currentPeriodEnd: '2026-10-30T00:00:00.000Z' });
    const controller = makeBillingController({ confirmPaid }, { getStatusView });

    await expect(controller.confirmPaid('ORD1', PARENT)).resolves.toEqual({
      orderNo: 'ORD1',
      paymentStatus: 'paid',
      currentPeriodEnd: '2026-10-30T00:00:00.000Z',
    });
    expect(confirmPaid).toHaveBeenCalledWith(7, 'ORD1');
    expect(getStatusView).toHaveBeenCalledWith({ role: 'parent', sub: 7 });
  });
});

describe('BillingCallbackController 委派', () => {
  it('合法渠道：headers 与 rawBody 原样透传给 service，按 ChannelHttpResponse 直写响应', async () => {
    const rawBody = Buffer.from('{"resource":"x"}');
    const reply = { httpStatus: 200, body: '{"code":"SUCCESS"}', contentType: 'application/json' };
    const handleCallback = vi.fn().mockResolvedValue(reply);
    const controller = makeCallbackController(handleCallback);
    const res = mockRes();

    await controller.handleCallback('wechat', { rawBody } as unknown as RawBodyRequest<Request>, { 'wechat-signature': 'sig' }, res);

    expect(handleCallback).toHaveBeenCalledTimes(1);
    const [channel, headers, body] = handleCallback.mock.calls[0];
    expect(channel).toBe('wechat');
    expect(headers).toEqual({ 'wechat-signature': 'sig' });
    expect(Buffer.isBuffer(body)).toBe(true);
    expect((body as Buffer).equals(rawBody)).toBe(true);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.type).toHaveBeenCalledWith('application/json');
    expect(res.send).toHaveBeenCalledWith('{"code":"SUCCESS"}');
  });

  it('非法渠道：直接 404/1002，service 不被调（mock 等非真实渠道不走 HTTP 回调）', async () => {
    const handleCallback = vi.fn();
    const controller = makeCallbackController(handleCallback);
    const res = mockRes();

    await controller.handleCallback('mock', {} as unknown as RawBodyRequest<Request>, {}, res);

    expect(handleCallback).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.type).toHaveBeenCalledWith('application/json');
    expect(res.send).toHaveBeenCalledWith(JSON.stringify({ code: 1002, message: '未知支付渠道' }));
  });
});

describe('AdminBillingController 委派', () => {
  it('mark-paid：透传 orderNo + 操作人 JWT sub（审计），paid/duplicate 都回 paymentStatus=paid', async () => {
    const adminMarkPaid = vi.fn().mockResolvedValue('paid');
    const controller = makeAdminController(adminMarkPaid);
    const admin: JwtUser = { sub: 9, role: 'admin' };

    await expect(controller.markPaid('ORD1', admin)).resolves.toEqual({ orderNo: 'ORD1', paymentStatus: 'paid' });
    expect(adminMarkPaid).toHaveBeenCalledWith('ORD1', 9);

    (adminMarkPaid as ReturnType<typeof vi.fn>).mockResolvedValue('duplicate');
    await expect(controller.markPaid('ORD1', admin)).resolves.toEqual({ orderNo: 'ORD1', paymentStatus: 'paid' });
  });
});
