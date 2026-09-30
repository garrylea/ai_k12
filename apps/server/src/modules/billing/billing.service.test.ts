import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { BillingService } from './billing.service';
import type { OrderRow } from '../../database/repositories/orders.repo.js';

/**
 * BillingService 状态机用例（brief Step 1 六组 + 状态机边界）。
 * 全部 mock 依赖：pool（事务骨架）/ ordersRepo / plansRepo / subscriptionsService / 三渠道适配器。
 * vitest 下 NODE_ENV==='test'，channel='mock' 走 mockAdapter —— 用它驱动全流程。
 */

const MINUTE = 60_000;

function mkAdapter(channel: string) {
  return {
    channel,
    createOrder: vi.fn().mockResolvedValue({ tradeNo: `T-${channel}`, qrContent: `qr://${channel}`, redirectUrl: null }),
    queryOrder: vi.fn().mockResolvedValue({ paid: true, tradeNo: `T-${channel}`, amountCents: null }),
    verifyCallback: vi.fn().mockResolvedValue({ orderNo: 'ORD1', tradeNo: 'T1', paid: true, amountCents: 2000 }),
    successResponse: vi.fn().mockReturnValue({ httpStatus: 200, body: 'ok', contentType: 'text/plain' }),
    failureResponse: vi.fn().mockReturnValue({ httpStatus: 500, body: 'fail', contentType: 'text/plain' }),
  };
}

function mkConn() {
  return {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
}

function mkDeps() {
  const conn = mkConn();
  return {
    conn,
    pool: { getConnection: vi.fn().mockResolvedValue(conn) },
    ordersRepo: {
      insertOrder: vi.fn().mockResolvedValue(101),
      findByOrderNo: vi.fn().mockResolvedValue(null),
      findPendingByParent: vi.fn().mockResolvedValue(null),
      listByParent: vi.fn().mockResolvedValue({ total: 0, rows: [] }),
      expireStale: vi.fn().mockResolvedValue(0),
      markPaidTx: vi.fn().mockResolvedValue(1),
      setChannelResult: vi.fn().mockResolvedValue(undefined),
      cancelPending: vi.fn().mockResolvedValue(1),
      markClaim: vi.fn().mockResolvedValue(undefined),
      findClaims: vi.fn().mockResolvedValue({ total: 0, rows: [] }),
    },
    plansRepo: {
      findActiveByCode: vi.fn().mockResolvedValue({
        id: 1,
        plan_code: 'month',
        name: '月卡',
        price_cents: 2000,
        duration_days: 30,
      }),
    },
    subscriptionsService: {
      renewWithinTx: vi.fn().mockResolvedValue({ currentPeriodEnd: new Date() }),
    },
    wechatAdapter: mkAdapter('wechat'),
    alipayAdapter: mkAdapter('alipay'),
    mockAdapter: mkAdapter('mock'),
  };
}

type Deps = ReturnType<typeof mkDeps>;

const mkSvc = (d: Deps) =>
  new BillingService(
    d.pool as never,
    d.ordersRepo as never,
    d.plansRepo as never,
    d.subscriptionsService as never,
    d.wechatAdapter as never,
    d.alipayAdapter as never,
    d.mockAdapter as never,
  );

// RowDataPacket 自带 `constructor.name='RowDataPacket'` 品牌属性，plain 字面量无法满足
// Partial<OrderRow> 的弱类型检查，override 参数里把它剔除（测试里从不覆盖它）。
type OrderRowOverrides = Partial<Omit<OrderRow, 'constructor'>>;

function mkOrder(over: OrderRowOverrides = {}): OrderRow {
  return {
    id: 11,
    order_no: 'ORD1',
    parent_id: 3,
    plan_id: 1,
    plan_snapshot: { planCode: 'month', name: '月卡', priceCents: 2000, durationDays: 30 },
    amount_cents: 2000,
    payment_status: 'pending',
    channel: 'mock',
    channel_trade_no: null,
    channel_qr_content: null,
    paid_at: null,
    cancelled_at: null,
    expires_at: new Date(Date.now() + 60 * MINUTE),
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  } as OrderRow;
}

describe('BillingService.createOrder', () => {
  it('套餐下架/不存在 -> NotFoundException 404 code=2005，不建单不调渠道', async () => {
    const d = mkDeps();
    d.plansRepo.findActiveByCode.mockResolvedValue(null);
    await expect(mkSvc(d).createOrder(3, { planCode: 'month', channel: 'mock' })).rejects.toMatchObject({
      status: 404,
      response: { code: 2005 },
    });
    expect(d.ordersRepo.insertOrder).not.toHaveBeenCalled();
    expect(d.mockAdapter.createOrder).not.toHaveBeenCalled();
  });

  it('非法渠道（非 wechat/alipay，且非 test 环境的 mock）-> 1001', async () => {
    const d = mkDeps();
    await expect(mkSvc(d).createOrder(3, { planCode: 'month', channel: 'paypal' })).rejects.toMatchObject({
      status: 400,
      response: { code: 1001 },
    });
    expect(d.plansRepo.findActiveByCode).not.toHaveBeenCalled();
  });

  it("NODE_ENV!=='test' 且未开 BILLING_USE_MOCK 时 channel='mock' 被拒 -> 1001", async () => {
    const d = mkDeps();
    const prev = process.env.NODE_ENV;
    const prevMock = process.env.BILLING_USE_MOCK;
    process.env.NODE_ENV = 'production';
    delete process.env.BILLING_USE_MOCK;
    try {
      await expect(mkSvc(d).createOrder(3, { planCode: 'month', channel: 'mock' })).rejects.toMatchObject({
        response: { code: 1001 },
      });
    } finally {
      process.env.NODE_ENV = prev;
      if (prevMock !== undefined) process.env.BILLING_USE_MOCK = prevMock;
    }
    expect(d.ordersRepo.insertOrder).not.toHaveBeenCalled();
  });

  it('入口先惰性翻转 expireStale，再查 pending（防僵尸单复用/挡重下）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ id: 101, order_no: 'ORD-GEN' }));
    await mkSvc(d).createOrder(3, { planCode: 'month', channel: 'mock' });
    expect(d.ordersRepo.expireStale).toHaveBeenCalledTimes(1);
    expect(d.ordersRepo.expireStale.mock.invocationCallOrder[0]).toBeLessThan(
      d.ordersRepo.findPendingByParent.mock.invocationCallOrder[0],
    );
  });

  it('同套餐同渠道已有 pending -> 复用返回：不新建行、不调适配器、不回写', async () => {
    const d = mkDeps();
    const pending = mkOrder({ channel_qr_content: 'qr://mock' });
    d.ordersRepo.findPendingByParent.mockResolvedValue(pending);
    const view = await mkSvc(d).createOrder(3, { planCode: 'month', channel: 'mock' });
    expect(view.orderNo).toBe('ORD1');
    expect(d.ordersRepo.insertOrder).not.toHaveBeenCalled();
    expect(d.mockAdapter.createOrder).not.toHaveBeenCalled();
    expect(d.ordersRepo.setChannelResult).not.toHaveBeenCalled();
  });

  it('已有 pending 但换套餐 -> 2002（防串单）', async () => {
    const d = mkDeps();
    d.ordersRepo.findPendingByParent.mockResolvedValue(mkOrder({ plan_snapshot: { planCode: 'year', name: '年卡', priceCents: 19800, durationDays: 365 } }));
    await expect(mkSvc(d).createOrder(3, { planCode: 'month', channel: 'mock' })).rejects.toMatchObject({
      response: { code: 2002 },
    });
    expect(d.ordersRepo.insertOrder).not.toHaveBeenCalled();
  });

  it('已有 pending 但换渠道 -> 2002（防串单）', async () => {
    const d = mkDeps();
    d.ordersRepo.findPendingByParent.mockResolvedValue(mkOrder({ channel: 'wechat' }));
    await expect(mkSvc(d).createOrder(3, { planCode: 'month', channel: 'alipay' })).rejects.toMatchObject({
      response: { code: 2002 },
    });
  });

  it('新建单：pending -> 建单 -> 调适配器 -> 回写 tradeNo/qrContent -> 返回视图', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ id: 101, order_no: 'ORD-GEN' }));
    const before = Date.now();
    const view = await mkSvc(d).createOrder(3, { planCode: 'month', channel: 'mock' });

    expect(d.ordersRepo.insertOrder).toHaveBeenCalledTimes(1);
    const input = d.ordersRepo.insertOrder.mock.calls[0][0] as {
      orderNo: string;
      parentId: number;
      planId: number;
      planSnapshot: { planCode: string; name: string; priceCents: number; durationDays: number };
      amountCents: number;
      channel: string;
      expiresAt: Date;
    };
    expect(input.orderNo).toMatch(/^ORD\d{14}\d{6}$/);
    expect(input.parentId).toBe(3);
    expect(input.planId).toBe(1);
    expect(input.planSnapshot).toEqual({ planCode: 'month', name: '月卡', priceCents: 2000, durationDays: 30 });
    expect(input.amountCents).toBe(2000); // 金额来自 DB 套餐行，不信任前端
    expect(input.channel).toBe('mock');
    // 2h 超时（ORDER_PENDING_TTL_MINUTES=120），允许 1 分钟误差
    expect(Math.abs(input.expiresAt.getTime() - (before + 120 * MINUTE))).toBeLessThan(MINUTE);

    expect(d.mockAdapter.createOrder).toHaveBeenCalledWith({
      orderNo: input.orderNo,
      amountCents: 2000,
      description: '月卡',
    });
    expect(d.ordersRepo.setChannelResult).toHaveBeenCalledWith(101, 'T-mock', 'qr://mock');
    expect(view).toMatchObject({
      orderNo: 'ORD-GEN',
      paymentStatus: 'pending',
      amountCents: 2000,
      planName: '月卡',
      channel: 'mock',
    });
    expect(view.createdAt).toBeTypeOf('string');
    expect(view.paidAt).toBeNull();
  });

  it('BILLING_USE_MOCK=1 时 channel=wechat 也解析到 Mock（UI 无 mock radio，本地走查依赖此映射）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ id: 101, order_no: 'ORD-GEN', channel: 'wechat' }));
    const prevMock = process.env.BILLING_USE_MOCK;
    process.env.BILLING_USE_MOCK = '1';
    try {
      const view = await mkSvc(d).createOrder(3, { planCode: 'month', channel: 'wechat' });
      expect(d.ordersRepo.insertOrder).toHaveBeenCalledTimes(1);
      expect((d.ordersRepo.insertOrder.mock.calls[0][0] as { channel: string }).channel).toBe('wechat');
      expect(d.mockAdapter.createOrder).toHaveBeenCalledWith({
        orderNo: expect.any(String),
        amountCents: 2000,
        description: '月卡',
      });
      expect(d.wechatAdapter.createOrder).not.toHaveBeenCalled();
      expect(view).toMatchObject({ orderNo: 'ORD-GEN', channel: 'wechat' });
    } finally {
      if (prevMock === undefined) delete process.env.BILLING_USE_MOCK;
      else process.env.BILLING_USE_MOCK = prevMock;
    }
  });

  it('order_no 撞 uk_orders_no -> 重试一次（两次单号不同），第二次成功', async () => {
    const d = mkDeps();
    d.ordersRepo.insertOrder
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }))
      .mockResolvedValueOnce(102);
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ id: 102 }));
    await mkSvc(d).createOrder(3, { planCode: 'month', channel: 'mock' });
    expect(d.ordersRepo.insertOrder).toHaveBeenCalledTimes(2);
    const no1 = (d.ordersRepo.insertOrder.mock.calls[0][0] as { orderNo: string }).orderNo;
    const no2 = (d.ordersRepo.insertOrder.mock.calls[1][0] as { orderNo: string }).orderNo;
    expect(no1).not.toBe(no2);
  });

  it('order_no 连撞两次 -> 向外抛（只重试一次）', async () => {
    const d = mkDeps();
    const dup = Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
    d.ordersRepo.insertOrder.mockRejectedValue(dup);
    await expect(mkSvc(d).createOrder(3, { planCode: 'month', channel: 'mock' })).rejects.toBe(dup);
    expect(d.ordersRepo.insertOrder).toHaveBeenCalledTimes(2);
  });

  it('适配器下单抛 2003 -> 原样透传（订单保留 pending，无回写）', async () => {
    const d = mkDeps();
    d.mockAdapter.createOrder.mockRejectedValue(new HttpException({ code: 2003, message: '支付渠道异常' }, 503));
    await expect(mkSvc(d).createOrder(3, { planCode: 'month', channel: 'mock' })).rejects.toMatchObject({
      status: 503,
      response: { code: 2003 },
    });
    expect(d.ordersRepo.insertOrder).toHaveBeenCalledTimes(1); // 订单保留 pending，可取消/等超时后重下
    expect(d.ordersRepo.setChannelResult).not.toHaveBeenCalled();
  });

  it('适配器抛非 HttpException -> 包装成 503/2003', async () => {
    const d = mkDeps();
    d.mockAdapter.createOrder.mockRejectedValue(new Error('socket hang up'));
    await expect(mkSvc(d).createOrder(3, { planCode: 'month', channel: 'mock' })).rejects.toMatchObject({
      status: 503,
      response: { code: 2003 },
    });
  });
});

describe('BillingService.finalizePaidOrder（事务骨架）', () => {
  it('markPaidTx 影响行 1 -> renewWithinTx 同 conn 调用 -> COMMIT -> paid；release 必达', async () => {
    const d = mkDeps();
    const now = new Date('2026-09-29T10:00:00.000Z');
    const result = await mkSvc(d).finalizePaidOrder(mkOrder(), 'T-EXT', now);
    expect(result).toBe('paid');
    expect(d.ordersRepo.markPaidTx).toHaveBeenCalledWith(d.conn, 11, 'T-EXT', now);
    expect(d.subscriptionsService.renewWithinTx).toHaveBeenCalledWith(d.conn, 3, 'month', 30);
    expect(d.conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(d.conn.commit).toHaveBeenCalledTimes(1);
    expect(d.conn.rollback).not.toHaveBeenCalled();
    expect(d.conn.release).toHaveBeenCalledTimes(1);
  });

  it('markPaidTx 影响行 0（并发已终态）-> ROLLBACK、不续期 -> duplicate', async () => {
    const d = mkDeps();
    d.ordersRepo.markPaidTx.mockResolvedValue(0);
    const result = await mkSvc(d).finalizePaidOrder(mkOrder(), 'T-EXT');
    expect(result).toBe('duplicate');
    expect(d.conn.rollback).toHaveBeenCalledTimes(1);
    expect(d.conn.commit).not.toHaveBeenCalled();
    expect(d.subscriptionsService.renewWithinTx).not.toHaveBeenCalled();
    expect(d.conn.release).toHaveBeenCalledTimes(1);
  });

  it('续期抛错 -> ROLLBACK 并原样上抛（订单与订阅同生共死）', async () => {
    const d = mkDeps();
    d.subscriptionsService.renewWithinTx.mockRejectedValue(new Error('renew failed'));
    await expect(mkSvc(d).finalizePaidOrder(mkOrder(), 'T-EXT')).rejects.toThrow('renew failed');
    expect(d.conn.rollback).toHaveBeenCalledTimes(1);
    expect(d.conn.commit).not.toHaveBeenCalled();
    expect(d.conn.release).toHaveBeenCalledTimes(1);
  });
});

describe('BillingService.handleCallback', () => {
  const call = (d: Deps, channel = 'mock') =>
    mkSvc(d).handleCallback(channel, { 'content-type': 'application/json' }, Buffer.from('{}'));

  it('验签/解析抛错 -> failureResponse，不碰库', async () => {
    const d = mkDeps();
    d.mockAdapter.verifyCallback.mockRejectedValue(new Error('bad signature'));
    const res = await call(d);
    expect(res).toEqual({ httpStatus: 500, body: 'fail', contentType: 'text/plain' });
    expect(d.mockAdapter.failureResponse).toHaveBeenCalled();
    expect(d.ordersRepo.findByOrderNo).not.toHaveBeenCalled();
  });

  it('订单不存在 -> failureResponse', async () => {
    const d = mkDeps();
    await call(d);
    expect(d.mockAdapter.failureResponse).toHaveBeenCalled();
    expect(d.mockAdapter.successResponse).not.toHaveBeenCalled();
  });

  it('order.channel 与回调渠道不符 -> failureResponse（防串单）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ channel: 'wechat' }));
    await call(d, 'mock');
    expect(d.mockAdapter.failureResponse).toHaveBeenCalled();
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
  });

  it('金额不符 -> warn 留痕 + 不 finalize + failureResponse', async () => {
    const d = mkDeps();
    d.mockAdapter.verifyCallback.mockResolvedValue({ orderNo: 'ORD1', tradeNo: 'T1', paid: true, amountCents: 999 });
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    await call(d);
    expect(d.mockAdapter.failureResponse).toHaveBeenCalled();
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
    expect(d.subscriptionsService.renewWithinTx).not.toHaveBeenCalled();
  });

  it('非支付通知（paid=false）-> successResponse 确认收到，不 finalize', async () => {
    const d = mkDeps();
    d.mockAdapter.verifyCallback.mockResolvedValue({ orderNo: 'ORD1', tradeNo: 'T1', paid: false, amountCents: 2000 });
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    await call(d);
    expect(d.mockAdapter.successResponse).toHaveBeenCalled();
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
  });

  it('已 paid 订单重复通知 -> successResponse 幂等，不再 finalize', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ payment_status: 'paid' }));
    await call(d);
    expect(d.mockAdapter.successResponse).toHaveBeenCalled();
    expect(d.pool.getConnection).not.toHaveBeenCalled();
  });

  it('BILLING_USE_MOCK=1 时 wechat 渠道伪造回调（裸 JSON）→ 走真实适配器验签失败 -> failureResponse，不入账', async () => {
    // 终审必修 1 回归钉：resolveCallbackAdapter 不得把 wechat/alipay 映射到 Mock
    // （否则裸 JSON 零验签即可入账）。mock 模式入账既定路径是 confirm-paid。
    const d = mkDeps();
    d.wechatAdapter.verifyCallback.mockRejectedValue(new Error('验签失败'));
    const prevMock = process.env.BILLING_USE_MOCK;
    process.env.BILLING_USE_MOCK = '1';
    try {
      const res = await mkSvc(d).handleCallback('wechat', {}, Buffer.from('{"orderNo":"ORD1","paid":true}'));
      expect(res).toEqual({ httpStatus: 500, body: 'fail', contentType: 'text/plain' });
      expect(d.wechatAdapter.verifyCallback).toHaveBeenCalled();
      expect(d.mockAdapter.verifyCallback).not.toHaveBeenCalled();
      expect(d.ordersRepo.findByOrderNo).not.toHaveBeenCalled();
      expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
    } finally {
      if (prevMock === undefined) delete process.env.BILLING_USE_MOCK;
      else process.env.BILLING_USE_MOCK = prevMock;
    }
  });

  it('expired 终态订单 + 验签金额全过的合法支付回调 -> 照常入账（订阅顺延，2026-09-30 方案 A）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ payment_status: 'expired' }));
    await call(d);
    expect(d.mockAdapter.successResponse).toHaveBeenCalled();
    expect(d.ordersRepo.markPaidTx).toHaveBeenCalledWith(d.conn, 11, 'T1', expect.any(Date));
    expect(d.subscriptionsService.renewWithinTx).toHaveBeenCalledWith(d.conn, 3, 'month', 30);
    expect(d.conn.commit).toHaveBeenCalledTimes(1);
  });

  it('cancelled 终态订单收到支付回调 -> failureResponse + error 留痕（显式预警，需人工）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ payment_status: 'cancelled' }));
    const svc = mkSvc(d);
    const errSpy = vi.spyOn(
      (svc as unknown as { logger: { error: (...a: unknown[]) => void } }).logger,
      'error',
    );
    await svc.handleCallback('mock', { 'content-type': 'application/json' }, Buffer.from('{}'));
    expect(d.mockAdapter.failureResponse).toHaveBeenCalled();
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
    expect(d.subscriptionsService.renewWithinTx).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain('已取消订单收到真支付回调');
    expect(String(errSpy.mock.calls[0][0])).toContain('orderNo=ORD1');
  });

  it('pending + 支付成功 -> finalize 事务（同 conn 续期）-> successResponse', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    const res = await call(d);
    expect(d.mockAdapter.successResponse).toHaveBeenCalled();
    expect(d.ordersRepo.markPaidTx).toHaveBeenCalledWith(d.conn, 11, 'T1', expect.any(Date));
    expect(d.subscriptionsService.renewWithinTx).toHaveBeenCalledWith(d.conn, 3, 'month', 30);
    expect(d.conn.commit).toHaveBeenCalledTimes(1);
  });

  it('finalize 返回 duplicate（并发竞态）-> 仍 successResponse（幂等）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    d.ordersRepo.markPaidTx.mockResolvedValue(0);
    await call(d);
    expect(d.mockAdapter.successResponse).toHaveBeenCalled();
  });

  it('finalize 抛错（入账失败）-> failureResponse 应答渠道，不向外抛', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    d.ordersRepo.markPaidTx.mockRejectedValue(new Error('db down'));
    const res = await call(d);
    expect(res).toEqual({ httpStatus: 500, body: 'fail', contentType: 'text/plain' });
    expect(d.mockAdapter.failureResponse).toHaveBeenCalledWith('入账失败');
    expect(d.mockAdapter.successResponse).not.toHaveBeenCalled();
  });
});

describe('BillingService.confirmPaid', () => {
  it('入口先惰性翻转 expireStale，再找单', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ payment_status: 'paid' }));
    await mkSvc(d).confirmPaid(3, 'ORD1');
    expect(d.ordersRepo.expireStale).toHaveBeenCalled();
    expect(d.ordersRepo.expireStale.mock.invocationCallOrder[0]).toBeLessThan(
      d.ordersRepo.findByOrderNo.mock.invocationCallOrder[0],
    );
  });

  it('查单已支付 -> finalize 事务 -> paid', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    d.mockAdapter.queryOrder.mockResolvedValue({ paid: true, tradeNo: 'T-Q', amountCents: 2000 });
    const result = await mkSvc(d).confirmPaid(3, 'ORD1');
    expect(result.result).toBe('paid');
    expect(d.mockAdapter.queryOrder).toHaveBeenCalledWith('ORD1');
    expect(d.ordersRepo.markPaidTx).toHaveBeenCalledWith(d.conn, 11, 'T-Q', expect.any(Date));
    expect(d.subscriptionsService.renewWithinTx).toHaveBeenCalledWith(d.conn, 3, 'month', 30);
  });

  it('查单未支付 -> HttpException 400 code=2004，不 finalize', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    d.mockAdapter.queryOrder.mockResolvedValue({ paid: false, tradeNo: null, amountCents: null });
    await expect(mkSvc(d).confirmPaid(3, 'ORD1')).rejects.toMatchObject({
      status: 400,
      response: { code: 2004 },
    });
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
  });

  it('查单金额与订单不符 -> 2004 且不 finalize', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    d.mockAdapter.queryOrder.mockResolvedValue({ paid: true, tradeNo: 'T-Q', amountCents: 1 });
    await expect(mkSvc(d).confirmPaid(3, 'ORD1')).rejects.toMatchObject({ response: { code: 2004 } });
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
  });

  it('订单已 paid -> 直接 duplicate（幂等，不再调渠道）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ payment_status: 'paid' }));
    const result = await mkSvc(d).confirmPaid(3, 'ORD1');
    expect(result.result).toBe('duplicate');
    expect(d.mockAdapter.queryOrder).not.toHaveBeenCalled();
  });

  it('cancelled/expired -> 2002', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ payment_status: 'expired' }));
    await expect(mkSvc(d).confirmPaid(3, 'ORD1')).rejects.toMatchObject({ response: { code: 2002 } });
    expect(d.mockAdapter.queryOrder).not.toHaveBeenCalled();
  });

  it('不存在或他人订单 -> 403 code=1005', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(null);
    await expect(mkSvc(d).confirmPaid(3, 'ORD1')).rejects.toMatchObject({
      status: 403,
      response: { code: 1005 },
    });
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ parent_id: 999 }));
    await expect(mkSvc(d).confirmPaid(3, 'ORD1')).rejects.toMatchObject({ response: { code: 1005 } });
  });
});

describe('BillingService.cancel', () => {
  it('pending -> 置 cancelled 并返回视图（cancelledAt 落库）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    const view = await mkSvc(d).cancel(3, 'ORD1');
    expect(view.paymentStatus).toBe('cancelled');
    expect(d.ordersRepo.cancelPending).toHaveBeenCalledWith(11, expect.any(Date));
  });

  it('非 pending（paid）-> 2002，不动库', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ payment_status: 'paid' }));
    await expect(mkSvc(d).cancel(3, 'ORD1')).rejects.toMatchObject({ response: { code: 2002 } });
    expect(d.ordersRepo.cancelPending).not.toHaveBeenCalled();
  });

  it('他人订单 -> 1005', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ parent_id: 999 }));
    await expect(mkSvc(d).cancel(3, 'ORD1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('并发竞态：cancelPending 影响 0 行 -> 2002', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    d.ordersRepo.cancelPending.mockResolvedValue(0);
    await expect(mkSvc(d).cancel(3, 'ORD1')).rejects.toMatchObject({ response: { code: 2002 } });
  });
});

describe('BillingService.adminMarkPaid', () => {
  it('pending -> finalize，tradeNo=manual-{orderNo}', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    const result = await mkSvc(d).adminMarkPaid('ORD1');
    expect(result).toBe('paid');
    expect(d.ordersRepo.markPaidTx).toHaveBeenCalledWith(d.conn, 11, 'manual-ORD1', expect.any(Date));
    expect(d.subscriptionsService.renewWithinTx).toHaveBeenCalledWith(d.conn, 3, 'month', 30);
  });

  it('审计留痕（2026-09-30 方案 A）：adminId/单号/结果进 logger.log（paid 与 duplicate 两条路径都记）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    const svc = mkSvc(d);
    const logSpy = vi.spyOn((svc as unknown as { logger: { log: (...a: unknown[]) => void } }).logger, 'log');
    await expect(svc.adminMarkPaid('ORD1', 42)).resolves.toBe('paid');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain('adminId=42');
    expect(String(logSpy.mock.calls[0][0])).toContain('orderNo=ORD1');
    expect(String(logSpy.mock.calls[0][0])).toContain('result=paid');

    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ payment_status: 'paid' }));
    await expect(svc.adminMarkPaid('ORD1', 42)).resolves.toBe('duplicate');
    expect(String(logSpy.mock.calls[1][0])).toContain('result=duplicate');
  });

  it('已 paid -> duplicate（幂等成功），不再进事务', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ payment_status: 'paid' }));
    const result = await mkSvc(d).adminMarkPaid('ORD1');
    expect(result).toBe('duplicate');
    expect(d.pool.getConnection).not.toHaveBeenCalled();
  });

  it('cancelled/expired -> 2002', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ payment_status: 'expired' }));
    await expect(mkSvc(d).adminMarkPaid('ORD1')).rejects.toMatchObject({ response: { code: 2002 } });
  });

  it('订单不存在 -> NotFoundException 404', async () => {
    const d = mkDeps();
    await expect(mkSvc(d).adminMarkPaid('ORDX')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('BillingService.getOrder / listOrders（读时惰性翻转 + 分页）', () => {
  it('getOrder：先 expireStale 再找单；返回 OrderDetailView 含 qrContent/redirectUrl/claim 三态', async () => {
    const d = mkDeps();
    const created = new Date('2026-09-29T08:00:00.000Z');
    const expires = new Date('2026-09-29T10:00:00.000Z');
    d.ordersRepo.findByOrderNo.mockResolvedValue(
      mkOrder({ channel_qr_content: 'qr://mock', created_at: created, expires_at: expires }),
    );
    const detail = await mkSvc(d).getOrder(3, 'ORD1');
    expect(d.ordersRepo.expireStale.mock.invocationCallOrder[0]).toBeLessThan(
      d.ordersRepo.findByOrderNo.mock.invocationCallOrder[0],
    );
    expect(detail).toEqual({
      orderNo: 'ORD1',
      paymentStatus: 'pending',
      amountCents: 2000,
      planName: '月卡',
      channel: 'mock',
      createdAt: created.toISOString(),
      expiresAt: expires.toISOString(),
      paidAt: null,
      qrContent: 'qr://mock',
      redirectUrl: null,
      claimStatus: null,
      claimNote: null,
    });
  });

  it('getOrder：claim 转人工核实的订单透传 claimStatus/claimNote', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(
      mkOrder({ claim_status: 'pending_review', claim_note: '家长说已付' }),
    );
    const detail = await mkSvc(d).getOrder(3, 'ORD1');
    expect(detail.claimStatus).toBe('pending_review');
    expect(detail.claimNote).toBe('家长说已付');
  });

  it('getOrder：他人订单 -> 1005', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ parent_id: 999 }));
    await expect(mkSvc(d).getOrder(3, 'ORD1')).rejects.toMatchObject({ response: { code: 1005 } });
  });

  it('listOrders：先 expireStale；默认 page=1/pageSize=20 透传 repo', async () => {
    const d = mkDeps();
    d.ordersRepo.listByParent.mockResolvedValue({
      total: 1,
      rows: [mkOrder({ payment_status: 'paid', paid_at: new Date('2026-09-29T09:00:00.000Z') })],
    });
    const res = await mkSvc(d).listOrders(3);
    expect(d.ordersRepo.expireStale.mock.invocationCallOrder[0]).toBeLessThan(
      d.ordersRepo.listByParent.mock.invocationCallOrder[0],
    );
    expect(d.ordersRepo.listByParent).toHaveBeenCalledWith(3, 1, 20);
    expect(res).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(res.items[0]).toMatchObject({
      orderNo: 'ORD1',
      paymentStatus: 'paid',
      paidAt: new Date('2026-09-29T09:00:00.000Z').toISOString(),
      claimStatus: null,
      claimNote: null,
    });
    expect(res.items[0]).not.toHaveProperty('qrContent');
  });

  it('listOrders：page/pageSize 显式传参透传', async () => {
    const d = mkDeps();
    await mkSvc(d).listOrders(3, 2, 50);
    expect(d.ordersRepo.listByParent).toHaveBeenCalledWith(3, 2, 50);
  });

  it.each([
    ['page=0', 0, 20],
    ['page=1.5', 1.5, 20],
    ['pageSize=0', 1, 0],
    ['pageSize=51', 1, 51],
    ['pageSize=2.5', 1, 2.5],
  ])('listOrders 越界（%s）-> 400/1001 不钳制（仓规）', async (_name, page, pageSize) => {
    const d = mkDeps();
    await expect(mkSvc(d).listOrders(3, page as number, pageSize as number)).rejects.toMatchObject({
      status: 400,
      response: { code: 1001 },
    });
    expect(d.ordersRepo.listByParent).not.toHaveBeenCalled();
  });
});

describe('BillingService.getOrder 自动查单（maybeQueryChannel，批④ Task 2）', () => {
  it('pending wechat 单：GET 自动查渠道，paid -> finalize 入账（零点击到账）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ channel: 'wechat' }));
    // mkAdapter 默认 queryOrder -> { paid: true, tradeNo: 'T-wechat', amountCents: null }
    await mkSvc(d).getOrder(3, 'ORD1');
    expect(d.wechatAdapter.queryOrder).toHaveBeenCalledWith('ORD1');
    expect(d.ordersRepo.markPaidTx).toHaveBeenCalledWith(d.conn, 11, 'T-wechat', expect.any(Date));
    expect(d.subscriptionsService.renewWithinTx).toHaveBeenCalledWith(d.conn, 3, 'month', 30);
    expect(d.conn.commit).toHaveBeenCalledTimes(1);
  });

  it('微信查单 tradeNo=null -> finalize 用 query-{orderNo} 兜底', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ channel: 'wechat' }));
    d.wechatAdapter.queryOrder.mockResolvedValue({ paid: true, tradeNo: null, amountCents: null });
    await mkSvc(d).getOrder(3, 'ORD1');
    expect(d.ordersRepo.markPaidTx).toHaveBeenCalledWith(d.conn, 11, 'query-ORD1', expect.any(Date));
  });

  it('10s 限频：间隔内二次 GET 只查一次渠道，跨过 10s 再查（fake timers 推进）', async () => {
    vi.useFakeTimers();
    try {
      const d = mkDeps();
      d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ channel: 'wechat' }));
      d.wechatAdapter.queryOrder.mockResolvedValue({ paid: false, tradeNo: null, amountCents: null });
      const svc = mkSvc(d);
      await svc.getOrder(3, 'ORD1');
      expect(d.wechatAdapter.queryOrder).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await svc.getOrder(3, 'ORD1');
      expect(d.wechatAdapter.queryOrder).toHaveBeenCalledTimes(1); // 限频窗口内不再查
      await vi.advanceTimersByTimeAsync(10_000);
      await svc.getOrder(3, 'ORD1');
      expect(d.wechatAdapter.queryOrder).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('渠道查单抛 2003 类异常 -> GET 正常返回 DB 状态，不向外抛、不 finalize', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ channel: 'wechat' }));
    d.wechatAdapter.queryOrder.mockRejectedValue(new HttpException({ code: 2003, message: '支付渠道异常' }, 503));
    const detail = await mkSvc(d).getOrder(3, 'ORD1');
    expect(detail.paymentStatus).toBe('pending');
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
  });

  it('expired 单渠道 paid -> 照常 finalize（markPaidTx 已放行 expired，同回调方案 A 口径）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(
      mkOrder({ channel: 'wechat', payment_status: 'expired' }),
    );
    d.wechatAdapter.queryOrder.mockResolvedValue({ paid: true, tradeNo: 'T-WX', amountCents: 2000 });
    await mkSvc(d).getOrder(3, 'ORD1');
    expect(d.ordersRepo.markPaidTx).toHaveBeenCalledWith(d.conn, 11, 'T-WX', expect.any(Date));
    expect(d.subscriptionsService.renewWithinTx).toHaveBeenCalledWith(d.conn, 3, 'month', 30);
  });

  it("channel='mock' 不触发查单（演示模式的入账只走 confirm-paid）", async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder()); // channel='mock'，pending
    await mkSvc(d).getOrder(3, 'ORD1');
    expect(d.mockAdapter.queryOrder).not.toHaveBeenCalled();
    expect(d.wechatAdapter.queryOrder).not.toHaveBeenCalled();
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
  });

  it('BILLING_USE_MOCK=1 时 wechat 单自动查单仍走真实适配器（不被 mock 截胡，callback 口径回归钉）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ channel: 'wechat' }));
    const prevMock = process.env.BILLING_USE_MOCK;
    process.env.BILLING_USE_MOCK = '1';
    try {
      await mkSvc(d).getOrder(3, 'ORD1');
      expect(d.wechatAdapter.queryOrder).toHaveBeenCalledWith('ORD1');
      expect(d.mockAdapter.queryOrder).not.toHaveBeenCalled();
      expect(d.ordersRepo.markPaidTx).toHaveBeenCalledWith(d.conn, 11, 'T-wechat', expect.any(Date));
    } finally {
      if (prevMock === undefined) delete process.env.BILLING_USE_MOCK;
      else process.env.BILLING_USE_MOCK = prevMock;
    }
  });

  it('渠道报金额与订单不符 -> 拒绝入账 + warn 留痕（同 confirmPaid/回调口径）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ channel: 'wechat' }));
    d.wechatAdapter.queryOrder.mockResolvedValue({ paid: true, tradeNo: 'T-WX', amountCents: 1 });
    const svc = mkSvc(d);
    const warnSpy = vi.spyOn(
      (svc as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger,
      'warn',
    );
    await svc.getOrder(3, 'ORD1');
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('金额不符');
  });
});

describe('BillingService.confirmPaid claim 落库（批④ Task 3）', () => {
  it('查单未支付 -> 2004 落 claim pending_review（note 透传、claimed_at 刷新），错误体带 claimStatus 与新 message', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    d.mockAdapter.queryOrder.mockResolvedValue({ paid: false, tradeNo: null, amountCents: null });
    await expect(mkSvc(d).confirmPaid(3, 'ORD1', '已扫码')).rejects.toMatchObject({
      status: 400,
      response: { code: 2004, message: '渠道尚未确认，已转人工核实', claimStatus: 'pending_review' },
    });
    expect(d.ordersRepo.markClaim).toHaveBeenCalledTimes(1);
    expect(d.ordersRepo.markClaim).toHaveBeenCalledWith(11, 'pending_review', '已扫码', expect.any(Date));
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
  });

  it('重复 confirm 幂等：每次都刷新 claimed_at（两次 markClaim pending_review），错误体同为 pending_review', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    d.mockAdapter.queryOrder.mockResolvedValue({ paid: false, tradeNo: null, amountCents: null });
    const svc = mkSvc(d);
    await expect(svc.confirmPaid(3, 'ORD1')).rejects.toMatchObject({ response: { claimStatus: 'pending_review' } });
    await expect(svc.confirmPaid(3, 'ORD1')).rejects.toMatchObject({ response: { claimStatus: 'pending_review' } });
    expect(d.ordersRepo.markClaim).toHaveBeenCalledTimes(2);
    expect(d.ordersRepo.markClaim).toHaveBeenNthCalledWith(2, 11, 'pending_review', undefined, expect.any(Date));
  });

  it('note 超过 200 字 -> 400/1001，不查渠道不落 claim', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder());
    await expect(mkSvc(d).confirmPaid(3, 'ORD1', '长'.repeat(201))).rejects.toMatchObject({
      status: 400,
      response: { code: 1001 },
    });
    expect(d.mockAdapter.queryOrder).not.toHaveBeenCalled();
    expect(d.ordersRepo.markClaim).not.toHaveBeenCalled();
  });

  it('查单已支付且 claim=pending_review -> 成功返回 { result: paid, claimStatus: approved }（finalize 挂点闭环）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ claim_status: 'pending_review' }));
    d.mockAdapter.queryOrder.mockResolvedValue({ paid: true, tradeNo: 'T-Q', amountCents: 2000 });
    await expect(mkSvc(d).confirmPaid(3, 'ORD1')).resolves.toEqual({ result: 'paid', claimStatus: 'approved' });
    expect(d.ordersRepo.markClaim).toHaveBeenCalledWith(11, 'approved');
  });

  it('订单已 paid（duplicate）-> claimStatus 原样透传订单行', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ payment_status: 'paid', claim_status: 'approved' }));
    await expect(mkSvc(d).confirmPaid(3, 'ORD1')).resolves.toEqual({
      result: 'duplicate',
      claimStatus: 'approved',
    });
  });
});

describe('BillingService.finalizePaidOrder claim 闭环（批④ Task 3）', () => {
  it('成功入账且 claim=pending_review -> COMMIT 之后（事务外）一条 UPDATE 置 approved', async () => {
    const d = mkDeps();
    const result = await mkSvc(d).finalizePaidOrder(mkOrder({ claim_status: 'pending_review' }), 'T-EXT');
    expect(result).toBe('paid');
    expect(d.conn.commit).toHaveBeenCalledTimes(1);
    expect(d.ordersRepo.markClaim).toHaveBeenCalledTimes(1);
    expect(d.ordersRepo.markClaim).toHaveBeenCalledWith(11, 'approved');
    // 挂点在 commit 之后
    expect(d.ordersRepo.markClaim.mock.invocationCallOrder[0]).toBeGreaterThan(d.conn.commit.mock.invocationCallOrder[0]);
  });

  it('claim 为 null / approved / rejected -> 不再动 claim', async () => {
    const d = mkDeps();
    await mkSvc(d).finalizePaidOrder(mkOrder({ claim_status: null }), 'T-EXT');
    await mkSvc(d).finalizePaidOrder(mkOrder({ claim_status: 'approved' }), 'T-EXT');
    await mkSvc(d).finalizePaidOrder(mkOrder({ claim_status: 'rejected' }), 'T-EXT');
    expect(d.ordersRepo.markClaim).not.toHaveBeenCalled();
  });

  it('claim UPDATE 失败 -> 只 warn，不回滚入账（仍返回 paid）', async () => {
    const d = mkDeps();
    d.ordersRepo.markClaim.mockRejectedValue(new Error('db down'));
    const svc = mkSvc(d);
    const warnSpy = vi.spyOn((svc as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn');
    const result = await svc.finalizePaidOrder(mkOrder({ claim_status: 'pending_review' }), 'T-EXT');
    expect(result).toBe('paid');
    expect(d.conn.commit).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('BillingService.approveClaim / rejectClaim（批④ Task 3）', () => {
  it('approve：pending 单 + pending_review -> finalize（tradeNo=manual-）+ claim approved，返回 paid', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ claim_status: 'pending_review' }));
    const result = await mkSvc(d).approveClaim('ORD1', 42);
    expect(result).toBe('paid');
    expect(d.ordersRepo.markPaidTx).toHaveBeenCalledWith(d.conn, 11, 'manual-ORD1', expect.any(Date));
    expect(d.ordersRepo.markClaim).toHaveBeenCalledWith(11, 'approved');
    expect(d.subscriptionsService.renewWithinTx).toHaveBeenCalledWith(d.conn, 3, 'month', 30);
  });

  it('approve：expired 单也放行（markPaidTx 放行 expired）-> paid + approved', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(
      mkOrder({ claim_status: 'pending_review', payment_status: 'expired' }),
    );
    const result = await mkSvc(d).approveClaim('ORD1', 42);
    expect(result).toBe('paid');
    expect(d.ordersRepo.markPaidTx).toHaveBeenCalledWith(d.conn, 11, 'manual-ORD1', expect.any(Date));
    expect(d.ordersRepo.markClaim).toHaveBeenCalledWith(11, 'approved');
  });

  it('approve：cancelled -> 2002，不 finalize 不动 claim', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(
      mkOrder({ claim_status: 'pending_review', payment_status: 'cancelled' }),
    );
    await expect(mkSvc(d).approveClaim('ORD1', 42)).rejects.toMatchObject({ response: { code: 2002 } });
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
    expect(d.ordersRepo.markClaim).not.toHaveBeenCalled();
  });

  it('approve：claim 非 pending_review（null/rejected）-> 2002，不 finalize', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ claim_status: null }));
    await expect(mkSvc(d).approveClaim('ORD1', 42)).rejects.toMatchObject({ response: { code: 2002 } });
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ claim_status: 'rejected' }));
    await expect(mkSvc(d).approveClaim('ORD1', 42)).rejects.toMatchObject({ response: { code: 2002 } });
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
  });

  it('approve：已 paid 但 claim 仍 pending_review -> duplicate + 只补 claim approved（不重复入账）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(
      mkOrder({ claim_status: 'pending_review', payment_status: 'paid' }),
    );
    const result = await mkSvc(d).approveClaim('ORD1', 42);
    expect(result).toBe('duplicate');
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
    expect(d.ordersRepo.markClaim).toHaveBeenCalledWith(11, 'approved');
  });

  it('approve：订单不存在 -> 404/1005', async () => {
    const d = mkDeps();
    await expect(mkSvc(d).approveClaim('ORDX', 42)).rejects.toMatchObject({
      status: 404,
      response: { code: 1005 },
    });
  });

  it('reject：pending_review -> rejected，reason 追加到 claim_note 尾部', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(
      mkOrder({ claim_status: 'pending_review', claim_note: '家长说已付' }),
    );
    await mkSvc(d).rejectClaim('ORD1', 42, '渠道查无此单');
    expect(d.ordersRepo.markClaim).toHaveBeenCalledTimes(1);
    expect(d.ordersRepo.markClaim).toHaveBeenCalledWith(11, 'rejected', '家长说已付；驳回：渠道查无此单');
  });

  it('reject：无 reason -> 追加「驳回」；无原 note -> 直接以「驳回：…」开头', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ claim_status: 'pending_review', claim_note: 'note1' }));
    await mkSvc(d).rejectClaim('ORD1', 42);
    expect(d.ordersRepo.markClaim).toHaveBeenCalledWith(11, 'rejected', 'note1；驳回');

    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ claim_status: 'pending_review', claim_note: null }));
    await mkSvc(d).rejectClaim('ORD1', 42, '查无此单');
    expect(d.ordersRepo.markClaim).toHaveBeenLastCalledWith(11, 'rejected', '驳回：查无此单');
  });

  it('reject：拼接超过 200 字 -> 截断 200（列宽）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(
      mkOrder({ claim_status: 'pending_review', claim_note: 'x'.repeat(195) }),
    );
    await mkSvc(d).rejectClaim('ORD1', 42, 'y'.repeat(30));
    const note = d.ordersRepo.markClaim.mock.calls[0][2] as string;
    expect(note.length).toBe(200);
    expect(note.startsWith('xxxxx')).toBe(true);
  });

  it('reject：claim 非 pending_review -> 2002；订单不存在 -> 404/1005；均不动 claim', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ claim_status: 'approved' }));
    await expect(mkSvc(d).rejectClaim('ORD1', 42)).rejects.toMatchObject({ response: { code: 2002 } });
    d.ordersRepo.findByOrderNo.mockResolvedValue(null);
    await expect(mkSvc(d).rejectClaim('ORDX', 42)).rejects.toMatchObject({ response: { code: 1005 } });
    expect(d.ordersRepo.markClaim).not.toHaveBeenCalled();
  });
});

describe('BillingService.manual 线下转账渠道（批④ Task 4）', () => {
  it('createOrder channel=manual -> 建单成功：不走适配器、不回写渠道结果，订单 pending、2h 超时照常', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ id: 101, order_no: 'ORD-GEN', channel: 'manual' }));
    const before = Date.now();
    const view = await mkSvc(d).createOrder(3, { planCode: 'month', channel: 'manual' });

    expect(d.ordersRepo.insertOrder).toHaveBeenCalledTimes(1);
    const input = d.ordersRepo.insertOrder.mock.calls[0][0] as { channel: string; expiresAt: Date };
    expect(input.channel).toBe('manual');
    // 2h 超时对 manual 同样适用（允许 1 分钟误差）
    expect(Math.abs(input.expiresAt.getTime() - (before + 120 * MINUTE))).toBeLessThan(MINUTE);
    // 不走适配器：三个渠道的 createOrder 都不调，也不回写 tradeNo/qrContent
    expect(d.wechatAdapter.createOrder).not.toHaveBeenCalled();
    expect(d.alipayAdapter.createOrder).not.toHaveBeenCalled();
    expect(d.mockAdapter.createOrder).not.toHaveBeenCalled();
    expect(d.ordersRepo.setChannelResult).not.toHaveBeenCalled();
    expect(view).toMatchObject({ orderNo: 'ORD-GEN', paymentStatus: 'pending', channel: 'manual', amountCents: 2000 });
  });

  it('manual 防串单自然生效：同套餐同渠道 pending 复用；换套餐 2002', async () => {
    const d = mkDeps();
    d.ordersRepo.findPendingByParent.mockResolvedValue(mkOrder({ channel: 'manual' }));
    const view = await mkSvc(d).createOrder(3, { planCode: 'month', channel: 'manual' });
    expect(view.orderNo).toBe('ORD1');
    expect(d.ordersRepo.insertOrder).not.toHaveBeenCalled();

    d.ordersRepo.findPendingByParent.mockResolvedValue(
      mkOrder({ channel: 'manual', plan_snapshot: { planCode: 'year', name: '年卡', priceCents: 19800, durationDays: 365 } }),
    );
    await expect(mkSvc(d).createOrder(3, { planCode: 'month', channel: 'manual' })).rejects.toMatchObject({
      response: { code: 2002 },
    });
  });

  it('confirmPaid manual 无 note（缺省/空串/纯空白）-> 400/1001「请填写转账备注」，不查渠道不落 claim', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ channel: 'manual' }));
    const svc = mkSvc(d);
    await expect(svc.confirmPaid(3, 'ORD1')).rejects.toMatchObject({
      status: 400,
      response: { code: 1001, message: '请填写转账备注' },
    });
    await expect(svc.confirmPaid(3, 'ORD1', '')).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(svc.confirmPaid(3, 'ORD1', '   ')).rejects.toMatchObject({ response: { code: 1001 } });
    expect(d.wechatAdapter.queryOrder).not.toHaveBeenCalled();
    expect(d.mockAdapter.queryOrder).not.toHaveBeenCalled();
    expect(d.ordersRepo.markClaim).not.toHaveBeenCalled();
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
  });

  it('confirmPaid manual 有 note -> 跳过渠道查单，直接落 claim pending_review（note 存 claim_note）+ 2004', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ channel: 'manual' }));
    await expect(mkSvc(d).confirmPaid(3, 'ORD1', '微信转账给张老师')).rejects.toMatchObject({
      status: 400,
      response: { code: 2004, message: '渠道尚未确认，已转人工核实', claimStatus: 'pending_review' },
    });
    expect(d.ordersRepo.markClaim).toHaveBeenCalledTimes(1);
    expect(d.ordersRepo.markClaim).toHaveBeenCalledWith(11, 'pending_review', '微信转账给张老师', expect.any(Date));
    // 无渠道可查：所有适配器 queryOrder 都不调，更不 finalize
    expect(d.wechatAdapter.queryOrder).not.toHaveBeenCalled();
    expect(d.alipayAdapter.queryOrder).not.toHaveBeenCalled();
    expect(d.mockAdapter.queryOrder).not.toHaveBeenCalled();
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
  });

  it('manual 单重复 confirm 幂等：每次刷新 claimed_at（pending_review），错误体口径不变', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ channel: 'manual' }));
    const svc = mkSvc(d);
    await expect(svc.confirmPaid(3, 'ORD1', '已转账')).rejects.toMatchObject({ response: { claimStatus: 'pending_review' } });
    await expect(svc.confirmPaid(3, 'ORD1', '已转账')).rejects.toMatchObject({ response: { claimStatus: 'pending_review' } });
    expect(d.ordersRepo.markClaim).toHaveBeenCalledTimes(2);
  });

  it('getOrder manual pending 单：不触发自动查单（channel 白名单外），qrContent=null', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ channel: 'manual' }));
    const detail = await mkSvc(d).getOrder(3, 'ORD1');
    expect(detail.channel).toBe('manual');
    expect(detail.qrContent).toBeNull();
    expect(detail.redirectUrl).toBeNull();
    expect(d.wechatAdapter.queryOrder).not.toHaveBeenCalled();
    expect(d.alipayAdapter.queryOrder).not.toHaveBeenCalled();
    expect(d.mockAdapter.queryOrder).not.toHaveBeenCalled();
    expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled();
  });

  it('adminMarkPaid 对 manual 单照常入账（裁决通过走既有路径，tradeNo=manual-{orderNo}）', async () => {
    const d = mkDeps();
    d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ channel: 'manual' }));
    const result = await mkSvc(d).adminMarkPaid('ORD1', 42);
    expect(result).toBe('paid');
    expect(d.ordersRepo.markPaidTx).toHaveBeenCalledWith(d.conn, 11, 'manual-ORD1', expect.any(Date));
    expect(d.subscriptionsService.renewWithinTx).toHaveBeenCalledWith(d.conn, 3, 'month', 30);
  });
});

describe('BillingService.listClaims（批④ Task 3）', () => {
  const mkClaimRow = (over: Partial<OrderRow & { parent_phone: string }> = {}) => ({
    ...mkOrder({
      claim_status: 'pending_review',
      claimed_at: new Date('2026-09-30T08:00:00.000Z'),
      claim_note: '家长说已付',
      payment_status: 'pending' as const,
    }),
    parent_phone: '13800000000',
    ...over,
  });

  it('status 缺省 pending_review；page/pageSize 默认 1/20；item 形状映射', async () => {
    const d = mkDeps();
    d.ordersRepo.findClaims.mockResolvedValue({ total: 1, rows: [mkClaimRow()] });
    const res = await mkSvc(d).listClaims();
    expect(d.ordersRepo.findClaims).toHaveBeenCalledWith('pending_review', 1, 20);
    expect(res).toEqual({
      total: 1,
      page: 1,
      pageSize: 20,
      items: [
        {
          orderNo: 'ORD1',
          parentPhone: '13800000000',
          planName: '月卡',
          amountCents: 2000,
          claimStatus: 'pending_review',
          claimedAt: '2026-09-30T08:00:00.000Z',
          claimNote: '家长说已付',
          paymentStatus: 'pending',
        },
      ],
    });
  });

  it('status/page/pageSize 显式传参透传 repo', async () => {
    const d = mkDeps();
    await mkSvc(d).listClaims('approved', 2, 10);
    expect(d.ordersRepo.findClaims).toHaveBeenCalledWith('approved', 2, 10);
  });

  it.each([
    ['status 非法', 'whatever', 1, 20],
    ['page=0', 'pending_review', 0, 20],
    ['pageSize=51', 'pending_review', 1, 51],
    ['pageSize=2.5', 'pending_review', 1, 2.5],
  ] as const)('listClaims 越界（%s）-> 400/1001 不钳制（仓规）', async (_name, status, page, pageSize) => {
    const d = mkDeps();
    await expect(mkSvc(d).listClaims(status as never, page as number, pageSize as number)).rejects.toMatchObject({
      status: 400,
      response: { code: 1001 },
    });
    expect(d.ordersRepo.findClaims).not.toHaveBeenCalled();
  });
});
