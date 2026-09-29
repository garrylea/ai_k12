import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AlipayQrPayAdapter } from './alipay-qr-pay.adapter.js';
import { MockPayAdapter } from './mock-pay.adapter.js';
import { WechatNativePayAdapter } from './wechat-native-pay.adapter.js';

describe('MockPayAdapter', () => {
  it('createOrder：tradeNo=MOCK-<orderNo>、qrContent=mock://pay/<orderNo>、redirectUrl=null', async () => {
    const adapter = new MockPayAdapter(true);
    await expect(
      adapter.createOrder({ orderNo: 'R20260929001', amountCents: 29900, description: '年卡' }),
    ).resolves.toEqual({ tradeNo: 'MOCK-R20260929001', qrContent: 'mock://pay/R20260929001', redirectUrl: null });
  });

  it('queryOrder：autoPaid=true → paid=true', async () => {
    const adapter = new MockPayAdapter(true);
    await expect(adapter.queryOrder('R1')).resolves.toEqual({
      paid: true,
      tradeNo: 'MOCK-R1',
      amountCents: null,
    });
  });

  it('queryOrder：autoPaid=false → paid=false（未支付轮询路径）', async () => {
    const adapter = new MockPayAdapter(false);
    await expect(adapter.queryOrder('R1')).resolves.toMatchObject({ paid: false });
  });

  it('verifyCallback：解析 rawBody JSON 为 CallbackPayload（headers 不参与）', async () => {
    const adapter = new MockPayAdapter();
    const rawBody = Buffer.from(
      JSON.stringify({ orderNo: 'R1', tradeNo: 'MOCK-R1', paid: true, amountCents: 29900 }),
      'utf8',
    );
    await expect(adapter.verifyCallback({ 'x-ignored': 'v' }, rawBody)).resolves.toEqual({
      orderNo: 'R1',
      tradeNo: 'MOCK-R1',
      paid: true,
      amountCents: 29900,
    });
  });

  it('successResponse：200 + {"code":"SUCCESS"}，application/json', () => {
    expect(new MockPayAdapter().successResponse()).toEqual({
      httpStatus: 200,
      body: JSON.stringify({ code: 'SUCCESS' }),
      contentType: 'application/json',
    });
  });

  it('failureResponse：500 + {"code":"FAIL","message":...}', () => {
    const res = new MockPayAdapter().failureResponse('订单不存在');
    expect(res.httpStatus).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ code: 'FAIL', message: '订单不存在' });
    expect(res.contentType).toBe('application/json');
  });

  it('channel 固定为 mock（不伪装成真实渠道）', () => {
    expect(new MockPayAdapter().channel).toBe('mock');
  });
});

describe('空 env → 2003「支付渠道未配置」', () => {
  // WechatNativePayAdapter（Task 2 已实现）与 AlipayQrPayAdapter（Task 3 骨架）：
  // 空 env 下行为一致 —— 所有必需 env 缺失即抛 503/2003，不触网、不读文件。
  const cases: Array<[string, WechatNativePayAdapter | AlipayQrPayAdapter]> = [
    ['WechatNativePayAdapter', new WechatNativePayAdapter({} as NodeJS.ProcessEnv)],
    ['AlipayQrPayAdapter', new AlipayQrPayAdapter({} as NodeJS.ProcessEnv)],
  ];

  for (const [name, adapter] of cases) {
    it(`${name}：未配置时 createOrder/queryOrder 抛 HttpException 503 / code=2003「支付渠道未配置」`, async () => {
      const orderErr: HttpException = await adapter
        .createOrder({ orderNo: 'R1', amountCents: 1, description: 'x' })
        .then(
          () => {
            throw new Error('不应成功');
          },
          (e) => e,
        );
      expect(orderErr).toBeInstanceOf(HttpException);
      expect(orderErr.getStatus()).toBe(503);
      expect(orderErr.getResponse()).toMatchObject({ code: 2003, message: '支付渠道未配置' });

      const queryErr: HttpException = await adapter.queryOrder('R1').then(
        () => {
          throw new Error('不应成功');
        },
        (e) => e,
      );
      expect(queryErr).toBeInstanceOf(HttpException);
      expect(queryErr.getStatus()).toBe(503);
      expect(queryErr.getResponse()).toMatchObject({ code: 2003 });
    });
  }
});
