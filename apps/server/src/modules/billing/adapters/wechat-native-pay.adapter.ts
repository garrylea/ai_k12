import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type {
  CallbackPayload,
  ChannelHttpResponse,
  ChannelOrderResult,
  ChannelQueryResult,
  PayChannel,
  PayChannelAdapter,
} from '../pay-channel.types.js';
import { randomNonce, rsaSha256Sign, rsaSha256Verify, wechatAesGcmDecrypt } from '../pay-signing.js';

/**
 * 微信 Native 扫码支付适配器（批② Task 2 实现）。
 *
 * 纯 fetch + node:crypto，无第三方 SDK。与微信 APIv3 的交互：
 * - 下单 `POST /v3/pay/transactions/native`，响应只有 `{code_url}` —— **不返回交易号**，
 *   故 `createOrder` 返回 `tradeNo: null`，订单行 `channel_trade_no` 留 NULL，
 *   等回调/查单回填（用 out_trade_no 占位会与订单行的商户单号列撞 UNIQUE）。
 * - 查单 `GET /v3/pay/transactions/out-trade-no/{orderNo}?mchid={mchid}`，
 *   `trade_state === 'SUCCESS'` 即已支付。
 * - 回调验签：`Wechatpay-Timestamp/Nonce/Signature/Serial` 四头，
 *   验签串 `{ts}\n{nonce}\n{rawBody}\n`，用**平台证书**公钥验；
 *   Serial 与所配平台证书不符直接判失败（多证书轮换留后续）。
 *   Timestamp 做新鲜度校验（与服务器时间差 > 5 分钟判过期，防重放）。
 *   解密 resource 用 APIv3 key 的 AES-256-GCM（`wechatAesGcmDecrypt`）。
 *
 * **URL path 参与签名必须与请求行完全一致（含 query）** —— `buildAuthHeader`
 * 收到的 `urlPath` 就是最终请求 URL 的 path+query，两处共用同一变量。
 *
 * env（缺一即 2003）：`WXPAY_MCHID` / `WXPAY_APPID` / `WXPAY_SERIAL_NO` /
 * `WXPAY_PRIVATE_KEY_PATH` / `WXPAY_APIV3_KEY` / `WXPAY_PLATFORM_CERT_PATH` /
 * `WXPAY_NOTIFY_URL`。
 *
 * 私钥/平台证书文件路径**惰性加载一次缓存**；若配的是相对路径，以
 * `process.cwd()` 为基准解析（后端以 `node dist/main.js` 启动，部署时
 * 要么给绝对路径，要么保证以 apps/server 为 cwd 启动；选 cwd 而非
 * import.meta.url 定位，是为了让测试与部署行为一致、不依赖编译产物位置）。
 *
 * 故意**不加 `@Injectable()`**（CLAUDE.md 的 DI 坑：`NodeJS.ProcessEnv` 参数的
 * `design:paramtypes` 会是 `Object`）；Task 4 接线时用 useFactory 显式构造。
 */
export class WechatNativePayAdapter implements PayChannelAdapter {
  readonly channel: PayChannel = 'wechat';

  private static readonly BASE_URL = 'https://api.mch.weixin.qq.com';

  /** 下单/查单请求超时（毫秒）。 */
  private static readonly REQUEST_TIMEOUT_MS = 10_000;

  /** 回调时间戳新鲜度窗口（秒）：|服务器时间 - 头时间戳| 超过即判过期。 */
  private static readonly CALLBACK_TIMESTAMP_TOLERANCE_SECONDS = 300;

  private readonly mchId: string | undefined;
  private readonly appId: string | undefined;
  private readonly serialNo: string | undefined;
  private readonly privateKeyPath: string | undefined;
  private readonly apiV3Key: string | undefined;
  private readonly platformCertPath: string | undefined;
  private readonly notifyUrl: string | undefined;

  private privateKeyPemCache: string | null = null;
  private platformCertCache: { serialNo: string; publicKeyPem: string } | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.mchId = env.WXPAY_MCHID;
    this.appId = env.WXPAY_APPID;
    this.serialNo = env.WXPAY_SERIAL_NO;
    this.privateKeyPath = env.WXPAY_PRIVATE_KEY_PATH;
    this.apiV3Key = env.WXPAY_APIV3_KEY;
    this.platformCertPath = env.WXPAY_PLATFORM_CERT_PATH;
    this.notifyUrl = env.WXPAY_NOTIFY_URL;
  }

  /** 必需项是否齐备（Task 4 接线选渠道用）。 */
  isConfigured(): boolean {
    return (
      !!this.mchId &&
      !!this.appId &&
      !!this.serialNo &&
      !!this.privateKeyPath &&
      !!this.apiV3Key &&
      !!this.platformCertPath &&
      !!this.notifyUrl
    );
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new HttpException({ code: 2003, message: '支付渠道未配置' }, 503);
    }
  }

  /** 相对路径以 process.cwd() 为基准（见类注释）。 */
  private resolveKeyPath(p: string): string {
    return isAbsolute(p) ? p : resolve(process.cwd(), p);
  }

  private loadPrivateKeyPem(): string {
    if (this.privateKeyPemCache) return this.privateKeyPemCache;
    try {
      this.privateKeyPemCache = readFileSync(this.resolveKeyPath(this.privateKeyPath!), 'utf8');
    } catch {
      throw new HttpException({ code: 2003, message: '支付渠道未配置（商户私钥文件不可读）' }, 503);
    }
    return this.privateKeyPemCache;
  }

  /**
   * 平台证书惰性加载：取出证书序列号（与回调 `Wechatpay-Serial` 头比对）
   * 和验签用公钥（X509Certificate → SPKI PEM，喂给 rsaSha256Verify）。
   */
  private loadPlatformCert(): { serialNo: string; publicKeyPem: string } {
    if (this.platformCertCache) return this.platformCertCache;
    let pem: string;
    try {
      pem = readFileSync(this.resolveKeyPath(this.platformCertPath!), 'utf8');
    } catch {
      throw new HttpException({ code: 2003, message: '支付渠道未配置（平台证书文件不可读）' }, 503);
    }
    const cert = new X509Certificate(pem);
    this.platformCertCache = {
      serialNo: cert.serialNumber,
      publicKeyPem: cert.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
    return this.platformCertCache;
  }

  /**
   * 构造 Authorization 头。`urlPath` 必须是**最终请求行的 path+query**
   * （GET 查单带 `?mchid=...`），签名串与请求行逐字节一致：
   * `{method}\n{urlPath}\n{ts}\n{nonce}\n{body}\n`（GET 时 body 为空串）。
   */
  private buildAuthHeader(method: 'POST' | 'GET', urlPath: string, body: string): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomNonce();
    const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = rsaSha256Sign(this.loadPrivateKeyPem(), message);
    return (
      `WECHATPAY2-SHA256-RSA2048 mchid="${this.mchId}",nonce_str="${nonce}",` +
      `signature="${signature}",timestamp="${timestamp}",serial_no="${this.serialNo}"`
    );
  }

  /**
   * fetch 包一层超时：`AbortSignal.timeout` 中止时（AbortError/TimeoutError）
   * 转成现有 2003 渠道异常语义；其余错误原样抛出。
   */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(WechatNativePayAdapter.REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new HttpException({ code: 2003, message: '支付渠道请求超时' }, 503);
      }
      throw err;
    }
  }

  async createOrder(input: { orderNo: string; amountCents: number; description: string }): Promise<ChannelOrderResult> {
    this.assertConfigured();
    const urlPath = '/v3/pay/transactions/native';
    const body = JSON.stringify({
      appid: this.appId,
      mchid: this.mchId,
      description: input.description,
      out_trade_no: input.orderNo,
      notify_url: this.notifyUrl,
      amount: { total: input.amountCents },
    });
    const res = await this.fetchWithTimeout(`${WechatNativePayAdapter.BASE_URL}${urlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: this.buildAuthHeader('POST', urlPath, body),
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`微信下单失败: HTTP ${res.status} ${text}`);
    }
    const parsed = JSON.parse(text) as { code_url?: string };
    if (!parsed.code_url) {
      throw new Error(`微信下单响应缺少 code_url: ${text}`);
    }
    return { tradeNo: null, qrContent: parsed.code_url, redirectUrl: null };
  }

  async queryOrder(orderNo: string): Promise<ChannelQueryResult> {
    this.assertConfigured();
    const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(this.mchId!)}`;
    const res = await this.fetchWithTimeout(`${WechatNativePayAdapter.BASE_URL}${urlPath}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: this.buildAuthHeader('GET', urlPath, ''),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`微信查单失败: HTTP ${res.status} ${text}`);
    }
    const parsed = JSON.parse(text) as {
      trade_state?: string;
      transaction_id?: string;
      amount?: { total?: number };
    };
    return {
      paid: parsed.trade_state === 'SUCCESS',
      tradeNo: parsed.transaction_id ?? null,
      amountCents: parsed.amount?.total ?? null,
    };
  }

  /** 大小写不敏感取第一个出现的头（Node 进入的 headers 通常已小写）。 */
  private static headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== target) continue;
      if (Array.isArray(value)) return value[0];
      return value;
    }
    return undefined;
  }

  async verifyCallback(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<CallbackPayload> {
    this.assertConfigured();
    const timestamp = WechatNativePayAdapter.headerValue(headers, 'Wechatpay-Timestamp');
    const nonce = WechatNativePayAdapter.headerValue(headers, 'Wechatpay-Nonce');
    const signature = WechatNativePayAdapter.headerValue(headers, 'Wechatpay-Signature');
    const serial = WechatNativePayAdapter.headerValue(headers, 'Wechatpay-Serial');
    if (!timestamp || !nonce || !signature || !serial) {
      throw new Error('微信回调缺少验签头');
    }

    // 新鲜度校验：头值是秒级 epoch 字符串，与服务器时间差 > 5 分钟判过期（防重放）
    const tsSeconds = Number(timestamp);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      !Number.isFinite(tsSeconds) ||
      Math.abs(nowSeconds - tsSeconds) > WechatNativePayAdapter.CALLBACK_TIMESTAMP_TOLERANCE_SECONDS
    ) {
      throw new Error('微信回调时间戳过期');
    }

    const platformCert = this.loadPlatformCert();
    if (serial.toUpperCase() !== platformCert.serialNo.toUpperCase()) {
      throw new Error(`微信回调证书序列号不匹配: ${serial}`);
    }

    // 验签串：{ts}\n{nonce}\n{rawBody}\n（rawBody 用原始字节，勿重序列化）
    const message = `${timestamp}\n${nonce}\n${rawBody.toString('utf8')}\n`;
    if (!rsaSha256Verify(platformCert.publicKeyPem, message, signature)) {
      throw new Error('微信回调验签失败');
    }

    const envelope = JSON.parse(rawBody.toString('utf8')) as {
      resource?: { nonce?: string; associated_data?: string; ciphertext?: string };
    };
    const resource = envelope.resource;
    if (!resource?.nonce || !resource.ciphertext) {
      throw new Error('微信回调缺少 resource 密文');
    }
    const plaintext = wechatAesGcmDecrypt(
      this.apiV3Key!,
      resource.nonce,
      resource.associated_data ?? '',
      resource.ciphertext,
    );
    const payload = JSON.parse(plaintext) as {
      out_trade_no?: string;
      transaction_id?: string;
      trade_state?: string;
      amount?: { total?: number };
    };
    if (!payload.out_trade_no) {
      throw new Error('微信回调缺少 out_trade_no');
    }
    return {
      orderNo: payload.out_trade_no,
      tradeNo: payload.transaction_id ?? '',
      paid: payload.trade_state === 'SUCCESS',
      amountCents: payload.amount?.total ?? 0,
    };
  }

  successResponse(): ChannelHttpResponse {
    return {
      httpStatus: 200,
      body: JSON.stringify({ code: 'SUCCESS' }),
      contentType: 'application/json',
    };
  }

  failureResponse(message: string): ChannelHttpResponse {
    return {
      httpStatus: 500,
      body: JSON.stringify({ code: 'FAIL', message }),
      contentType: 'application/json',
    };
  }
}
