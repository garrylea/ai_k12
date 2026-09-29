import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, X509Certificate, createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WechatNativePayAdapter } from './wechat-native-pay.adapter.js';
import { rsaSha256Sign, rsaSha256Verify, wechatAesGcmDecrypt } from '../pay-signing.js';

/**
 * 测试物料：
 * - 商户私钥：crypto.generateKeyPairSync 生成，写临时文件（env 配的是路径）。
 * - 平台证书：openssl 自签（Node 无法生成 X.509），同一把密钥充当
 *   「平台私钥」用于给回调验签串签名 —— 适配器用证书里的公钥验签，
 *   正好构成往返。
 * - 下单/查单走 vi.stubGlobal('fetch') 拦截，断言 URL / body /
 *   Authorization（可用商户公钥还原签名串）。
 */
const tmpDir = mkdtempSync(join(tmpdir(), 'wxpay-adapter-'));

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const merchantPrivatePem = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const merchantPublicPem = merchant.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const merchantKeyPath = join(tmpDir, 'apiclient_key.pem');
writeFileSync(merchantKeyPath, merchantPrivatePem, 'utf8');

const platformKeyPath = join(tmpDir, 'platform_key.pem');
const platformCertPath = join(tmpDir, 'platform_cert.pem');

const API_V3_KEY = '0123456789abcdef0123456789abcdef';
const ENV: NodeJS.ProcessEnv = {
  WXPAY_MCHID: '1900000001',
  WXPAY_APPID: 'wx-appid-test',
  WXPAY_SERIAL_NO: 'TEST-MCH-SERIAL-01',
  WXPAY_PRIVATE_KEY_PATH: merchantKeyPath,
  WXPAY_APIV3_KEY: API_V3_KEY,
  WXPAY_PLATFORM_CERT_PATH: platformCertPath,
  WXPAY_NOTIFY_URL: 'https://example.com/api/billing/wechat/notify',
};

let platformSerialNo = '';
let platformPrivatePem = '';

beforeAll(() => {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', platformKeyPath, '-out', platformCertPath,
    '-days', '1', '-subj', '/CN=wxpay-platform-test',
  ]);
  platformPrivatePem = readFileSync(platformKeyPath, 'utf8');
  platformSerialNo = new X509Certificate(readFileSync(platformCertPath, 'utf8')).serialNumber;
});

/** 模拟微信侧 resource 加密：AES-256-GCM，密文尾部拼 16B authTag 再 base64。 */
function encryptLikeWechat(plaintext: string, nonce: string, aad: string): string {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(API_V3_KEY, 'utf8'), Buffer.from(nonce, 'utf8'));
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');
}

/** 从 Authorization 头解析 WECHATPAY2-SHA256-RSA2048 的各参数。 */
function parseAuthHeader(header: string): { mchid: string; nonce: string; signature: string; timestamp: string; serialNo: string } {
  expect(header.startsWith('WECHATPAY2-SHA256-RSA2048 ')).toBe(true);
  const params = Object.fromEntries(
    header
      .slice('WECHATPAY2-SHA256-RSA2048 '.length)
      .split(',')
      .map((kv) => {
        // 按第一个 '=' 切分：base64 签名尾部可能带 padding '='，split('=') 会截掉
        const k = kv.slice(0, kv.indexOf('='));
        const v = kv.slice(kv.indexOf('=') + 1);
        return [k.trim(), v.replace(/^"|"$/g, '')];
      }),
  ) as Record<string, string>;
  return {
    mchid: params.mchid,
    nonce: params.nonce_str,
    signature: params.signature,
    timestamp: params.timestamp,
    serialNo: params.serial_no,
  };
}

/** 构造带正确验签四头的回调（用平台私钥签名）。timestampSeconds 可覆盖时间戳（测新鲜度）。 */
function buildCallbackHeaders(
  rawBody: string,
  serialNo = platformSerialNo,
  signKey = platformPrivatePem,
  timestampSeconds?: number,
): Record<string, string | string[] | undefined> {
  const timestamp = (timestampSeconds ?? Math.floor(Date.now() / 1000)).toString();
  const nonce = randomBytes(8).toString('hex');
  const signature = rsaSha256Sign(signKey, `${timestamp}\n${nonce}\n${rawBody}\n`);
  // 刻意用小写头名：适配器必须大小写不敏感取头
  return {
    'wechatpay-timestamp': timestamp,
    'wechatpay-nonce': nonce,
    'wechatpay-signature': signature,
    'wechatpay-serial': serialNo,
  };
}

describe('WechatNativePayAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('createOrder', () => {
    it('POST native 下单：URL/body 正确，Authorization 可用商户公钥还原签名串；响应 code_url → qrContent，tradeNo=null', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code_url: 'weixin://wxpay/bizpayurl?pr=test123' }), { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new WechatNativePayAdapter(ENV);

      const result = await adapter.createOrder({ orderNo: 'R20260929001', amountCents: 29900, description: '年卡' });

      expect(result).toEqual({ tradeNo: null, qrContent: 'weixin://wxpay/bizpayurl?pr=test123', redirectUrl: null });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/native');
      expect(init.method).toBe('POST');
      const bodyStr = init.body as string;
      expect(JSON.parse(bodyStr)).toEqual({
        appid: 'wx-appid-test',
        mchid: '1900000001',
        description: '年卡',
        out_trade_no: 'R20260929001',
        notify_url: 'https://example.com/api/billing/wechat/notify',
        amount: { total: 29900 },
      });

      const auth = parseAuthHeader((init.headers as Record<string, string>)['Authorization']);
      expect(auth.mchid).toBe('1900000001');
      expect(auth.serialNo).toBe('TEST-MCH-SERIAL-01');
      const message = `POST\n/v3/pay/transactions/native\n${auth.timestamp}\n${auth.nonce}\n${bodyStr}\n`;
      expect(rsaSha256Verify(merchantPublicPem, message, auth.signature)).toBe(true);

      // 超时保护：fetch 收到 signal，且超时时长为 10s
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });

    it('createOrder/queryOrder 的 fetch 带 10s 超时 signal（AbortSignal.timeout(10_000)）', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ code_url: 'weixin://wxpay/bizpayurl?pr=x' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ trade_state: 'SUCCESS' }), { status: 200 }),
        );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new WechatNativePayAdapter(ENV);

      await adapter.createOrder({ orderNo: 'R1', amountCents: 1, description: 'x' });
      await adapter.queryOrder('R1');

      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
      for (const call of fetchMock.mock.calls) {
        expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
      }
      timeoutSpy.mockRestore();
    });

    it('微信返回非 2xx → 抛错（HTTP 状态与响应体进错误信息）', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'PARAM_ERROR' }), { status: 400 })),
      );
      const adapter = new WechatNativePayAdapter(ENV);
      await expect(adapter.createOrder({ orderNo: 'R1', amountCents: 1, description: 'x' })).rejects.toThrow(
        /微信下单失败: HTTP 400/,
      );
    });
  });

  describe('queryOrder', () => {
    it('GET 查单：URL 含 mchid query 且参与签名（签名串与请求行一致）；SUCCESS → paid=true + 回填交易号/金额', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ trade_state: 'SUCCESS', transaction_id: 'wx-txn-0001', amount: { total: 29900 } }),
          { status: 200 },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new WechatNativePayAdapter(ENV);

      const result = await adapter.queryOrder('R20260929001');

      expect(result).toEqual({ paid: true, tradeNo: 'wx-txn-0001', amountCents: 29900 });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/R20260929001?mchid=1900000001');
      expect(init.method).toBe('GET');
      const auth = parseAuthHeader((init.headers as Record<string, string>)['Authorization']);
      const message = `GET\n/v3/pay/transactions/out-trade-no/R20260929001?mchid=1900000001\n${auth.timestamp}\n${auth.nonce}\n\n`;
      expect(rsaSha256Verify(merchantPublicPem, message, auth.signature)).toBe(true);
    });

    it('trade_state=NOTPAY（无 transaction_id/amount）→ paid=false、tradeNo/amount 为 null', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ trade_state: 'NOTPAY' }), { status: 200 })),
      );
      const adapter = new WechatNativePayAdapter(ENV);
      await expect(adapter.queryOrder('R1')).resolves.toEqual({ paid: false, tradeNo: null, amountCents: null });
    });
  });

  describe('verifyCallback', () => {
    const resourceNonce = 'abc123def456'; // 12 个 ASCII 字符
    const plaintext = JSON.stringify({
      out_trade_no: 'R20260929001',
      transaction_id: 'wx-txn-0001',
      trade_state: 'SUCCESS',
      amount: { total: 29900 },
    });

    function buildCallbackBody(): string {
      return JSON.stringify({
        id: 'evt-test-1',
        resource: {
          nonce: resourceNonce,
          associated_data: 'transaction',
          ciphertext: encryptLikeWechat(plaintext, resourceNonce, 'transaction'),
        },
      });
    }

    it('验签+解密往返：平台私钥签名 → 通过；解密出 out_trade_no/transaction_id/amount.total；小写头名也能取到', async () => {
      const adapter = new WechatNativePayAdapter(ENV);
      const rawBody = Buffer.from(buildCallbackBody(), 'utf8');

      await expect(adapter.verifyCallback(buildCallbackHeaders(rawBody.toString('utf8')), rawBody)).resolves.toEqual({
        orderNo: 'R20260929001',
        tradeNo: 'wx-txn-0001',
        paid: true,
        amountCents: 29900,
      });
    });

    it('Wechatpay-Serial 与所配平台证书序列号不符 → 抛错（验签不通过）', async () => {
      const adapter = new WechatNativePayAdapter(ENV);
      const rawBody = Buffer.from(buildCallbackBody(), 'utf8');
      expect(platformSerialNo).not.toBe('DEADBEEF');
      await expect(
        adapter.verifyCallback(buildCallbackHeaders(rawBody.toString('utf8'), 'DEADBEEF'), rawBody),
      ).rejects.toThrow(/证书序列号不匹配/);
    });

    it('时间戳过期（>5 分钟）→ 抛「微信回调时间戳过期」', async () => {
      const adapter = new WechatNativePayAdapter(ENV);
      const rawBody = Buffer.from(buildCallbackBody(), 'utf8');
      const expiredTs = Math.floor(Date.now() / 1000) - 301;
      await expect(
        adapter.verifyCallback(buildCallbackHeaders(rawBody.toString('utf8'), platformSerialNo, platformPrivatePem, expiredTs), rawBody),
      ).rejects.toThrow('微信回调时间戳过期');
    });

    it('签名错误（用商户私钥而非平台私钥签）→ 抛「微信回调验签失败」', async () => {
      const adapter = new WechatNativePayAdapter(ENV);
      const rawBody = Buffer.from(buildCallbackBody(), 'utf8');
      await expect(
        adapter.verifyCallback(buildCallbackHeaders(rawBody.toString('utf8'), platformSerialNo, merchantPrivatePem), rawBody),
      ).rejects.toThrow('微信回调验签失败');
    });

    it('缺少任一验签头 → 抛错', async () => {
      const adapter = new WechatNativePayAdapter(ENV);
      const rawBody = Buffer.from(buildCallbackBody(), 'utf8');
      const headers = buildCallbackHeaders(rawBody.toString('utf8'));
      delete headers['wechatpay-signature'];
      await expect(adapter.verifyCallback(headers, rawBody)).rejects.toThrow('微信回调缺少验签头');
    });

    it('resource 密文被篡改 → GCM 校验失败抛错', async () => {
      const adapter = new WechatNativePayAdapter(ENV);
      const body = JSON.parse(buildCallbackBody()) as { resource: { ciphertext: string } };
      const buf = Buffer.from(body.resource.ciphertext, 'base64');
      buf[0] ^= 0xff;
      body.resource.ciphertext = buf.toString('base64');
      const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
      await expect(adapter.verifyCallback(buildCallbackHeaders(rawBody.toString('utf8')), rawBody)).rejects.toThrow();
    });

    it('解密后的 payload 缺 out_trade_no → 抛「微信回调缺少 out_trade_no」（不得静默返回空单号）', async () => {
      const adapter = new WechatNativePayAdapter(ENV);
      const noOrderNoPlaintext = JSON.stringify({
        transaction_id: 'wx-txn-0002',
        trade_state: 'SUCCESS',
        amount: { total: 29900 },
      });
      const nonce = resourceNonce;
      const body = JSON.stringify({
        id: 'evt-test-2',
        resource: {
          nonce,
          associated_data: 'transaction',
          ciphertext: encryptLikeWechat(noOrderNoPlaintext, nonce, 'transaction'),
        },
      });
      const rawBody = Buffer.from(body, 'utf8');
      await expect(adapter.verifyCallback(buildCallbackHeaders(body), rawBody)).rejects.toThrow(
        '微信回调缺少 out_trade_no',
      );
    });

    it('AES-GCM 解密往返（APIv3 key 加密样例 resource → 还原明文）', () => {
      const nonce = randomBytes(6).toString('hex');
      const ciphertext = encryptLikeWechat(plaintext, nonce, 'transaction');
      expect(wechatAesGcmDecrypt(API_V3_KEY, nonce, 'transaction', ciphertext)).toBe(plaintext);
    });
  });

  describe('successResponse / failureResponse', () => {
    it('success：200 + {"code":"SUCCESS"}；failure：500 + {"code":"FAIL","message":...}，均 application/json', () => {
      const adapter = new WechatNativePayAdapter(ENV);
      expect(adapter.successResponse()).toEqual({
        httpStatus: 200,
        body: JSON.stringify({ code: 'SUCCESS' }),
        contentType: 'application/json',
      });
      const res = adapter.failureResponse('验签失败');
      expect(res.httpStatus).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ code: 'FAIL', message: '验签失败' });
      expect(res.contentType).toBe('application/json');
    });
  });

  it('env 缺项 → isConfigured=false（完整 env 则 true）', () => {
    expect(new WechatNativePayAdapter(ENV).isConfigured()).toBe(true);
    expect(new WechatNativePayAdapter({} as NodeJS.ProcessEnv).isConfigured()).toBe(false);
  });
});
