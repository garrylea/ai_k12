import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AlipayQrPayAdapter,
  alipayTimestamp,
  centsToYuan,
  yuanToCents,
} from './alipay-qr-pay.adapter.js';
import { rsaSha256Sign, rsaSha256Verify } from '../pay-signing.js';

/**
 * 测试物料（同 Task 2 微信适配器手法）：
 * - 应用私钥：crypto.generateKeyPairSync 生成，写临时文件（env 配的是路径）；
 *   加签请求的签名用应用公钥还原验签串做往返。
 * - 支付宝侧密钥：再生成一把密钥对，**公钥**写文件充当 `ALIPAY_ALIPAY_PUBLIC_KEY_PATH`，
 *   **私钥**在测试里给 notify 回调签名 —— 适配器用配的公钥验签，正好构成往返；
 *   用应用私钥（错钥）签名样例覆盖「验签失败」。
 * - 下单/查单走 vi.stubGlobal('fetch') 拦截，断言 URL / form 参数 / 签名。
 */

const tmpDir = mkdtempSync(join(tmpdir(), 'alipay-adapter-'));
const GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway';
const NOTIFY_URL = 'https://example.com/api/billing/alipay/notify';

const appKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const appPrivatePem = appKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const appPublicPem = appKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const appKeyPath = join(tmpDir, 'app_private_key.pem');
writeFileSync(appKeyPath, appPrivatePem, 'utf8');

const alipayKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const alipayPrivatePem = alipayKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const alipayPublicKeyPath = join(tmpDir, 'alipay_public_key.pem');
writeFileSync(alipayPublicKeyPath, alipayKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'utf8');

const ENV: NodeJS.ProcessEnv = {
  ALIPAY_APP_ID: '2021000100000001',
  ALIPAY_GATEWAY: GATEWAY,
  ALIPAY_APP_PRIVATE_KEY_PATH: appKeyPath,
  ALIPAY_ALIPAY_PUBLIC_KEY_PATH: alipayPublicKeyPath,
  ALIPAY_NOTIFY_URL: NOTIFY_URL,
};

/** 与实现同一套待签名串规则（key ASCII 升序 k=v&…，无 sign，值原文）。 */
function buildSignString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

/** 解码 fetch 收到的 form body，断言签名可用给定公钥还原验签，返回解码后的参数。 */
function decodeAndVerifyForm(body: string, verifyKeyPem: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body).entries()) params[k] = v;
  const sign = params.sign;
  expect(sign).toBeTruthy();
  const verifyParams = { ...params };
  delete verifyParams.sign;
  expect(rsaSha256Verify(verifyKeyPem, buildSignString(verifyParams), sign)).toBe(true);
  return params;
}

/** 断言 timestamp 是 UTC+8 的「yyyy-MM-dd HH:mm:ss」且与当前时间差 < 120s。 */
function expectBeijingTimestamp(ts: string): void {
  expect(ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const [datePart, timePart] = ts.split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);
  const epoch = Date.UTC(y, mo - 1, d, h, mi, s) - 8 * 3600 * 1000;
  expect(Math.abs(Date.now() - epoch)).toBeLessThan(120_000);
}

/** 用支付宝侧私钥构造合法 notify 回调 body（验签串剔除 sign/sign_type）。 */
function buildNotifyBody(fields: Record<string, string>, signKeyPem = alipayPrivatePem): Buffer {
  const verifyParams = { ...fields };
  delete verifyParams.sign;
  delete verifyParams.sign_type;
  const sign = rsaSha256Sign(signKeyPem, buildSignString(verifyParams));
  return Buffer.from(new URLSearchParams({ ...fields, sign }).toString(), 'utf8');
}

describe('AlipayQrPayAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('金额换算（分 <-> 元字符串）', () => {
    it('centsToYuan 边界：1 -> "0.01"、19800 -> "198.00"、105 -> "1.05"', () => {
      expect(centsToYuan(1)).toBe('0.01');
      expect(centsToYuan(19800)).toBe('198.00');
      expect(centsToYuan(105)).toBe('1.05');
      expect(centsToYuan(0)).toBe('0.00');
      expect(centsToYuan(100)).toBe('1.00');
      expect(centsToYuan(999)).toBe('9.99');
      expect(centsToYuan(1000000)).toBe('10000.00');
    });

    it('yuanToCents 边界：与 centsToYuan 互逆；一位小数补零；非法输入抛错', () => {
      expect(yuanToCents('0.01')).toBe(1);
      expect(yuanToCents('198.00')).toBe(19800);
      expect(yuanToCents('1.05')).toBe(105);
      expect(yuanToCents('10')).toBe(1000);
      expect(yuanToCents('1.5')).toBe(150);
      for (const cents of [1, 105, 19800, 999999]) {
        expect(yuanToCents(centsToYuan(cents))).toBe(cents);
      }
      expect(() => yuanToCents('1.005')).toThrow(/无法解析的支付宝金额字符串/); // 三位小数，拒绝静默截断
      expect(() => yuanToCents('abc')).toThrow();
      expect(() => yuanToCents('')).toThrow();
      expect(() => yuanToCents('.5')).toThrow();
    });
  });

  describe('alipayTimestamp', () => {
    it('UTC+8 的 yyyy-MM-dd HH:mm:ss，不随部署机本地时区漂移', () => {
      const fixed = new Date('2026-09-29T20:00:05Z'); // UTC 20:00 → 北京 28 日 04:00 次日?
      // UTC 2026-09-29 20:00:05 = 北京时间 2026-09-30 04:00:05（跨日场景）
      expect(alipayTimestamp(fixed)).toBe('2026-09-30 04:00:05');
      expectBeijingTimestamp(alipayTimestamp());
    });
  });

  describe('createOrder', () => {
    it('form 参数齐全（公共参数/biz_content/timestamp UTC+8）、签名可用应用公钥还原；10000+qr_code → tradeNo=out_trade_no', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ alipay_trade_precreate_response: { code: '10000', msg: 'Success', out_trade_no: 'R20260929001', qr_code: 'https://qr.alipay.com/bax0001' } }),
          { status: 200 },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new AlipayQrPayAdapter(ENV);

      const result = await adapter.createOrder({ orderNo: 'R20260929001', amountCents: 29900, description: '年卡' });

      expect(result).toEqual({ tradeNo: 'R20260929001', qrContent: 'https://qr.alipay.com/bax0001', redirectUrl: null });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(GATEWAY);
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');

      const params = decodeAndVerifyForm(init.body as string, appPublicPem);
      expect(params.app_id).toBe('2021000100000001');
      expect(params.method).toBe('alipay.trade.precreate');
      expect(params.format).toBe('JSON');
      expect(params.charset).toBe('utf-8');
      expect(params.sign_type).toBe('RSA2');
      expect(params.version).toBe('1.0');
      expect(params.notify_url).toBe(NOTIFY_URL);
      expectBeijingTimestamp(params.timestamp);
      expect(JSON.parse(params.biz_content)).toEqual({
        out_trade_no: 'R20260929001',
        total_amount: '299.00', // 分 -> 元两位小数字符串
        subject: '年卡',
      });

      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });

    it('业务失败（code != 10000）→ 抛错并带 sub_msg', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ alipay_trade_precreate_response: { code: '40004', msg: 'Business Failed', sub_code: 'ACQ.INVALID_PARAMETER', sub_msg: '参数无效' } }),
            { status: 200 },
          ),
        ),
      );
      const adapter = new AlipayQrPayAdapter(ENV);
      await expect(adapter.createOrder({ orderNo: 'R1', amountCents: 1, description: 'x' })).rejects.toThrow(/支付宝业务失败.*ACQ.INVALID_PARAMETER/s);
    });

    it('10000 但缺 qr_code → 抛错（不得静默返回空二维码）', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ alipay_trade_precreate_response: { code: '10000', msg: 'Success' } }),
            { status: 200 },
          ),
        ),
      );
      const adapter = new AlipayQrPayAdapter(ENV);
      await expect(adapter.createOrder({ orderNo: 'R1', amountCents: 1, description: 'x' })).rejects.toThrow(/缺少 qr_code/);
    });

    it('网关 HTTP 非 2xx → 抛错（HTTP 状态与响应体进错误信息）', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('gateway error', { status: 502 })),
      );
      const adapter = new AlipayQrPayAdapter(ENV);
      await expect(adapter.createOrder({ orderNo: 'R1', amountCents: 1, description: 'x' })).rejects.toThrow(/支付宝下单失败: HTTP 502/);
    });
  });

  describe('queryOrder', () => {
    it('TRADE_SUCCESS + total_amount "198.00" → paid=true、trade_no、19800 分；receipt_amount（渠道优惠后偏小）不被采信', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            alipay_trade_query_response: {
              code: '10000', msg: 'Success',
              trade_no: '2026092922001000001', out_trade_no: 'R20260929001',
              trade_status: 'TRADE_SUCCESS', total_amount: '198.00', receipt_amount: '0.01',
            },
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new AlipayQrPayAdapter(ENV);

      const result = await adapter.queryOrder('R20260929001');

      expect(result).toEqual({ paid: true, tradeNo: '2026092922001000001', amountCents: 19800 });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(GATEWAY);
      const params = decodeAndVerifyForm(init.body as string, appPublicPem);
      expect(params.method).toBe('alipay.trade.query');
      expect(JSON.parse(params.biz_content)).toEqual({ out_trade_no: 'R20260929001' });
    });

    it('TRADE_FINISHED 也算已支付；TRADE_WAIT_BUYER_PAY 算未支付（total_amount 缺 → amountCents null）', async () => {
      const adapter = new AlipayQrPayAdapter(ENV);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(
          new Response(
            JSON.stringify({ alipay_trade_query_response: { code: '10000', msg: 'Success', trade_no: 'T1', trade_status: 'TRADE_FINISHED', total_amount: '1.00' } }),
            { status: 200 },
          ),
        ),
      );
      await expect(adapter.queryOrder('R1')).resolves.toEqual({ paid: true, tradeNo: 'T1', amountCents: 100 });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ alipay_trade_query_response: { code: '10000', msg: 'Success', trade_status: 'TRADE_WAIT_BUYER_PAY' } }),
            { status: 200 },
          ),
        ),
      );
      await expect(adapter.queryOrder('R1')).resolves.toEqual({ paid: false, tradeNo: null, amountCents: null });
    });

    it('交易不存在（40004 ACQ.TRADE_NOT_EXIST）→ 视为未支付而非渠道故障', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ alipay_trade_query_response: { code: '40004', msg: 'Business Failed', sub_code: 'ACQ.TRADE_NOT_EXIST', sub_msg: '交易不存在' } }),
            { status: 200 },
          ),
        ),
      );
      const adapter = new AlipayQrPayAdapter(ENV);
      await expect(adapter.queryOrder('R1')).resolves.toEqual({ paid: false, tradeNo: null, amountCents: null });
    });

    it('其余业务失败 → 抛错', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ alipay_trade_query_response: { code: '40003', msg: 'Insufficient Conditions', sub_code: 'ACQ.TRADE_STATUS_ERROR' } }),
            { status: 200 },
          ),
        ),
      );
      const adapter = new AlipayQrPayAdapter(ENV);
      await expect(adapter.queryOrder('R1')).rejects.toThrow(/支付宝查单业务失败/);
    });
  });

  describe('verifyCallback', () => {
    const baseFields = (): Record<string, string> => ({
      app_id: '2021000100000001',
      trade_no: '2026092922001000001',
      out_trade_no: 'R20260929001',
      total_amount: '299.00',
      trade_status: 'TRADE_SUCCESS',
      notify_id: 'n-0001',
      notify_type: 'trade_status_sync',
      sign_type: 'RSA2',
      charset: 'utf-8',
    });

    it('验签往返：支付宝侧私钥签名 → 通过；total_amount 元转分、TRADE_SUCCESS → paid', async () => {
      const adapter = new AlipayQrPayAdapter(ENV);
      const rawBody = buildNotifyBody(baseFields());
      await expect(adapter.verifyCallback({}, rawBody)).resolves.toEqual({
        orderNo: 'R20260929001',
        tradeNo: '2026092922001000001',
        paid: true,
        amountCents: 29900,
      });
    });

    it('TRADE_FINISHED → paid=true；TRADE_CLOSED → paid=false（都应答成功路径）', async () => {
      const adapter = new AlipayQrPayAdapter(ENV);
      const finished = baseFields();
      finished.trade_status = 'TRADE_FINISHED';
      await expect(adapter.verifyCallback({}, buildNotifyBody(finished))).resolves.toMatchObject({ paid: true });
      const closed = baseFields();
      closed.trade_status = 'TRADE_CLOSED';
      await expect(adapter.verifyCallback({}, buildNotifyBody(closed))).resolves.toMatchObject({ paid: false });
    });

    it('签名错误（用应用私钥而非支付宝侧私钥签）→ 抛「支付宝回调验签失败」', async () => {
      const adapter = new AlipayQrPayAdapter(ENV);
      const rawBody = buildNotifyBody(baseFields(), appPrivatePem);
      await expect(adapter.verifyCallback({}, rawBody)).rejects.toThrow('支付宝回调验签失败');
    });

    it('签后篡改 total_amount → 验签失败抛错（金额不能被改）', async () => {
      const adapter = new AlipayQrPayAdapter(ENV);
      const fields = baseFields();
      const rawBody = buildNotifyBody(fields);
      // 在合法签名 body 上把金额换成 0.01，签名不重算
      const tampered = new URLSearchParams(rawBody.toString('utf8'));
      tampered.set('total_amount', '0.01');
      await expect(adapter.verifyCallback({}, Buffer.from(tampered.toString(), 'utf8'))).rejects.toThrow('支付宝回调验签失败');
    });

    it('缺少 sign → 抛「支付宝回调缺少 sign」', async () => {
      const adapter = new AlipayQrPayAdapter(ENV);
      const rawBody = Buffer.from(new URLSearchParams(baseFields()).toString(), 'utf8');
      await expect(adapter.verifyCallback({}, rawBody)).rejects.toThrow('支付宝回调缺少 sign');
    });

    it('缺 out_trade_no → 抛「支付宝回调缺少 out_trade_no」（不得静默空串）', async () => {
      const adapter = new AlipayQrPayAdapter(ENV);
      const fields = baseFields();
      delete fields.out_trade_no;
      await expect(adapter.verifyCallback({}, buildNotifyBody(fields))).rejects.toThrow('支付宝回调缺少 out_trade_no');
    });

    it('缺 total_amount → 抛错（金额校验输入不得缺）', async () => {
      const adapter = new AlipayQrPayAdapter(ENV);
      const fields = baseFields();
      delete fields.total_amount;
      await expect(adapter.verifyCallback({}, buildNotifyBody(fields))).rejects.toThrow('支付宝回调缺少 total_amount');
    });

    it('app_id 与配置不符 → 抛「支付宝回调 app_id 不符」（官方四项校验之一，缺 app_id 同样抛）', async () => {
      const adapter = new AlipayQrPayAdapter(ENV);
      const mismatched = baseFields();
      mismatched.app_id = '2021000999999999';
      await expect(adapter.verifyCallback({}, buildNotifyBody(mismatched))).rejects.toThrow('支付宝回调 app_id 不符');
      const missing = baseFields();
      delete missing.app_id;
      await expect(adapter.verifyCallback({}, buildNotifyBody(missing))).rejects.toThrow('支付宝回调 app_id 不符');
    });

    it('缺 trade_no → 抛「支付宝回调缺少 trade_no」（不得静默空串）', async () => {
      const adapter = new AlipayQrPayAdapter(ENV);
      const fields = baseFields();
      delete fields.trade_no;
      await expect(adapter.verifyCallback({}, buildNotifyBody(fields))).rejects.toThrow('支付宝回调缺少 trade_no');
    });
  });

  describe('successResponse / failureResponse', () => {
    it('支付宝语义：都是 HTTP 200 纯文本 success / failure', () => {
      const adapter = new AlipayQrPayAdapter(ENV);
      expect(adapter.successResponse()).toEqual({ httpStatus: 200, body: 'success', contentType: 'text/plain' });
      expect(adapter.failureResponse('验签失败')).toEqual({ httpStatus: 200, body: 'failure', contentType: 'text/plain' });
    });
  });

  it('env 缺项 → isConfigured=false（完整 env 则 true）', () => {
    expect(new AlipayQrPayAdapter(ENV).isConfigured()).toBe(true);
    expect(new AlipayQrPayAdapter({} as NodeJS.ProcessEnv).isConfigured()).toBe(false);
    expect(
      new AlipayQrPayAdapter({ ...ENV, ALIPAY_NOTIFY_URL: undefined } as unknown as NodeJS.ProcessEnv).isConfigured(),
    ).toBe(false);
  });

  it('ALIPAY_GATEWAY 未配 → 用默认官方网关；配了 → 用自定义网关', async () => {
    const precreateOk = () =>
      new Response(
        JSON.stringify({ alipay_trade_precreate_response: { code: '10000', msg: 'Success', qr_code: 'qr-x' } }),
        { status: 200 },
      );
    const fetchMock = vi.fn().mockImplementation(precreateOk);
    vi.stubGlobal('fetch', fetchMock);
    const { ALIPAY_GATEWAY: _omit, ...envWithoutGateway } = ENV;
    const adapter = new AlipayQrPayAdapter(envWithoutGateway as NodeJS.ProcessEnv);
    await adapter.createOrder({ orderNo: 'R1', amountCents: 1, description: 'x' });
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('https://openapi.alipay.com/gateway');

    await new AlipayQrPayAdapter(ENV).createOrder({ orderNo: 'R1', amountCents: 1, description: 'x' });
    expect((fetchMock.mock.calls[1] as unknown[])[0]).toBe(GATEWAY);
  });
});
