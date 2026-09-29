import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpException } from '@nestjs/common';
import type {
  CallbackPayload,
  ChannelHttpResponse,
  ChannelOrderResult,
  ChannelQueryResult,
  PayChannel,
  PayChannelAdapter,
} from '../pay-channel.types.js';
import { rsaSha256Sign, rsaSha256Verify } from '../pay-signing.js';

/**
 * 分 -> 元字符串（支付宝金额字段是「元」两位小数的字符串）：
 * 1 -> "0.01"、19800 -> "198.00"、105 -> "1.05"。负数不出现（金额由订单层保证 > 0），
 * 但实现仍按符号处理，不静默吞。
 */
export function centsToYuan(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}${yuan}.${rem.toString().padStart(2, '0')}`;
}

/** 元字符串 -> 分：最多两位小数，超出精度直接抛（防静默截断造成金额错配）。 */
export function yuanToCents(yuan: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(yuan.trim());
  if (!m) throw new Error(`无法解析的支付宝金额字符串: ${JSON.stringify(yuan)}`);
  const [, neg, intPart, decPart = ''] = m;
  const cents = Number(intPart) * 100 + Number((decPart + '00').slice(0, 2));
  return neg ? -cents : cents;
}

/**
 * 支付宝网关要求的北京时间（UTC+8）「yyyy-MM-dd HH:mm:ss」。
 * 用 Date 本身加 8 小时后取 UTC 分量，避免依赖部署机的本地时区。
 */
export function alipayTimestamp(now: Date = new Date()): string {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
  );
}

/**
 * 支付宝扫码（当面付 qr_code）适配器（批② Task 3 实现）。
 *
 * 纯 fetch + node:crypto，无第三方 SDK。与支付宝开放网关的交互：
 * - 请求：form-urlencoded POST 到 gateway；公共参数 app_id / method / format=JSON /
 *   charset=utf-8 / sign_type=RSA2 / timestamp（UTC+8）/ version=1.0 / notify_url / biz_content。
 * - 签名：除 sign 外全部参数按 key ASCII 升序拼 `k=v` 用 `&` 连接（**值用原文，不做 URL 转义**，
 *   也不带尾 & —— 即官方 RSA2 规范的待签名串），app 私钥 RSA-SHA256 -> base64。
 *   实际 POST 的表单值才做 URL 编码（URLSearchParams 负责），编码发生在签名之后。
 * - 下单 method=alipay.trade.precreate，响应 `alipay_trade_precreate_response.code === '10000'`
 *   且取 `qr_code`；支付宝当面付**不返回预单号**，查单/回调都按 out_trade_no 定位，
 *   故 createOrder 返回 `tradeNo = out_trade_no`（types 已放宽为 string，Task 1 审定）。
 * - 查单 method=alipay.trade.query；`trade_status ∈ {TRADE_SUCCESS, TRADE_FINISHED}` 即已支付，
 *   取 trade_no / receipt_amount（元字符串转分）。交易不存在（ACQ.TRADE_NOT_EXIST）按未支付处理，
 *   让上层轮询自然等待，而不是把「还没付」当渠道故障抛 500。
 * - 回调验签：form-encoded body；剔除 sign/sign_type 后按 key 升序拼串，
 *   用**支付宝公钥** RSA-SHA256 验 sign。支付宝 notify 无时间戳新鲜度字段，不做防重放校验
 *   （金额与订单一致性校验主责在 service 层，这里只透出 amountCents）。
 * - 应答：纯文本 `success` / `failure`，HTTP 都是 200。
 *
 * env（缺一即 2003）：`ALIPAY_APP_ID` / `ALIPAY_GATEWAY`（默认
 * `https://openapi.alipay.com/gateway`）/ `ALIPAY_APP_PRIVATE_KEY_PATH`（应用私钥，加签用）/
 * `ALIPAY_ALIPAY_PUBLIC_KEY_PATH`（支付宝公钥，验回调签用）/ `ALIPAY_NOTIFY_URL`。
 *
 * 私钥/公钥文件**惰性加载一次缓存**；相对路径以**仓库根**为基准解析
 * （从本文件编译产物的 import.meta.url 向上找 `.git`；找不到兜底 process.cwd()）。
 * 选仓库根而非 cwd，是因为密钥配置写在仓库级 env、语义上属于仓库资产，
 * 不随启动目录漂移。
 *
 * 故意**不加 `@Injectable()`**（CLAUDE.md 的 DI 坑：`NodeJS.ProcessEnv` 参数的
 * `design:paramtypes` 会是 `Object`）；Task 4 接线时用 useFactory 显式构造。
 */
export class AlipayQrPayAdapter implements PayChannelAdapter {
  readonly channel: PayChannel = 'alipay';

  /** 下单/查单请求超时（毫秒），与微信适配器一致。 */
  private static readonly REQUEST_TIMEOUT_MS = 10_000;

  private static readonly DEFAULT_GATEWAY = 'https://openapi.alipay.com/gateway';

  private readonly appId: string | undefined;
  private readonly gateway: string;
  private readonly appPrivateKeyPath: string | undefined;
  private readonly alipayPublicKeyPath: string | undefined;
  private readonly notifyUrl: string | undefined;

  private appPrivateKeyPemCache: string | null = null;
  private alipayPublicKeyPemCache: string | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.appId = env.ALIPAY_APP_ID;
    this.gateway = env.ALIPAY_GATEWAY || AlipayQrPayAdapter.DEFAULT_GATEWAY;
    this.appPrivateKeyPath = env.ALIPAY_APP_PRIVATE_KEY_PATH;
    this.alipayPublicKeyPath = env.ALIPAY_ALIPAY_PUBLIC_KEY_PATH;
    this.notifyUrl = env.ALIPAY_NOTIFY_URL;
  }

  /** 必需项是否齐备（Task 4 接线选渠道用）。 */
  isConfigured(): boolean {
    return (
      !!this.appId &&
      !!this.appPrivateKeyPath &&
      !!this.alipayPublicKeyPath &&
      !!this.notifyUrl
    );
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new HttpException({ code: 2003, message: '支付渠道未配置' }, 503);
    }
  }

  /** 从本文件位置向上找 `.git` 定位仓库根；找不到兜底 process.cwd()（见类注释）。 */
  private static repoRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 12; i++) {
      if (existsSync(join(dir, '.git'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return process.cwd();
  }

  private resolveKeyPath(p: string): string {
    return isAbsolute(p) ? p : resolve(AlipayQrPayAdapter.repoRoot(), p);
  }

  private loadAppPrivateKeyPem(): string {
    if (this.appPrivateKeyPemCache) return this.appPrivateKeyPemCache;
    try {
      this.appPrivateKeyPemCache = readFileSync(this.resolveKeyPath(this.appPrivateKeyPath!), 'utf8');
    } catch {
      throw new HttpException({ code: 2003, message: '支付渠道未配置（应用私钥文件不可读）' }, 503);
    }
    return this.appPrivateKeyPemCache;
  }

  private loadAlipayPublicKeyPem(): string {
    if (this.alipayPublicKeyPemCache) return this.alipayPublicKeyPemCache;
    try {
      this.alipayPublicKeyPemCache = readFileSync(this.resolveKeyPath(this.alipayPublicKeyPath!), 'utf8');
    } catch {
      throw new HttpException({ code: 2003, message: '支付渠道未配置（支付宝公钥文件不可读）' }, 503);
    }
    return this.alipayPublicKeyPemCache;
  }

  /**
   * 待签名串：除 sign 外全部参数按 key ASCII 升序 `k=v` 用 `&` 连接，值不转义、不带尾 &。
   * 加签（公共参数+biz_content，剔除无）与验签（剔除 sign/sign_type）共用。
   */
  private static buildSignString(params: Record<string, string>): string {
    return Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
  }

  /** 公共参数 + biz_content，返回带 sign 的完整表单字段（值仍是原文，编码交给 URLSearchParams）。 */
  private buildSignedForm(method: string, bizContent: Record<string, unknown>): Record<string, string> {
    const params: Record<string, string> = {
      app_id: this.appId!,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: alipayTimestamp(),
      version: '1.0',
      notify_url: this.notifyUrl!,
      biz_content: JSON.stringify(bizContent),
    };
    const sign = rsaSha256Sign(this.loadAppPrivateKeyPem(), AlipayQrPayAdapter.buildSignString(params));
    return { ...params, sign };
  }

  /** 表单值 URL 编码后 POST 到网关。 */
  private async postForm(form: Record<string, string>): Promise<{ httpStatus: number; text: string }> {
    const res = await this.fetchWithTimeout(this.gateway, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
    });
    return { httpStatus: res.status, text: await res.text() };
  }

  /**
   * 业务响应统一校验：取 `{method 转下划线}_response` 节点，code 必须 '10000'，
   * 否则把 code/sub_code/sub_msg 带进错误信息（方便定位渠道侧问题）。
   */
  private static extractBizResponse(text: string, method: string): Record<string, unknown> {
    const node = `${method.replaceAll('.', '_')}_response`;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`支付宝响应不是合法 JSON: ${text}`);
    }
    const biz = parsed[node] as { code?: string; sub_code?: string; sub_msg?: string } | undefined;
    if (!biz || biz.code !== '10000') {
      throw new Error(`支付宝业务失败 (${method}): ${text}`);
    }
    return biz;
  }

  /**
   * fetch 包一层超时：`AbortSignal.timeout` 中止时（AbortError/TimeoutError）
   * 转成现有 2003 渠道异常语义；其余错误原样抛出。
   */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(AlipayQrPayAdapter.REQUEST_TIMEOUT_MS),
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
    const form = this.buildSignedForm('alipay.trade.precreate', {
      out_trade_no: input.orderNo,
      total_amount: centsToYuan(input.amountCents),
      subject: input.description,
    });
    const { httpStatus, text } = await this.postForm(form);
    if (httpStatus < 200 || httpStatus >= 300) {
      throw new Error(`支付宝下单失败: HTTP ${httpStatus} ${text}`);
    }
    const biz = AlipayQrPayAdapter.extractBizResponse(text, 'alipay.trade.precreate');
    const qrCode = biz.qr_code;
    if (typeof qrCode !== 'string' || !qrCode) {
      throw new Error(`支付宝下单响应缺少 qr_code: ${text}`);
    }
    // 支付宝无独立预单号，以 out_trade_no 充当（查单/回调都按它定位；Task 1 审定）
    return { tradeNo: input.orderNo, qrContent: qrCode, redirectUrl: null };
  }

  async queryOrder(orderNo: string): Promise<ChannelQueryResult> {
    this.assertConfigured();
    const form = this.buildSignedForm('alipay.trade.query', { out_trade_no: orderNo });
    const { httpStatus, text } = await this.postForm(form);
    if (httpStatus < 200 || httpStatus >= 300) {
      throw new Error(`支付宝查单失败: HTTP ${httpStatus} ${text}`);
    }
    // 交易不存在 → 视为未支付（等用户扫码），不当渠道故障抛
    let parsed: { alipay_trade_query_response?: { code?: string; sub_code?: string; trade_status?: string; trade_no?: string; receipt_amount?: string } };
    try {
      parsed = JSON.parse(text) as { alipay_trade_query_response?: { code?: string; sub_code?: string; trade_status?: string; trade_no?: string; receipt_amount?: string } };
    } catch {
      throw new Error(`支付宝响应不是合法 JSON: ${text}`);
    }
    const biz = parsed.alipay_trade_query_response;
    if (!biz || biz.code !== '10000') {
      if (biz?.code === '40004' && biz.sub_code === 'ACQ.TRADE_NOT_EXIST') {
        return { paid: false, tradeNo: null, amountCents: null };
      }
      throw new Error(`支付宝查单业务失败: ${text}`);
    }
    const paid = biz.trade_status === 'TRADE_SUCCESS' || biz.trade_status === 'TRADE_FINISHED';
    const receiptAmount = typeof biz.receipt_amount === 'string' ? biz.receipt_amount : null;
    return {
      paid,
      tradeNo: typeof biz.trade_no === 'string' && biz.trade_no ? biz.trade_no : null,
      amountCents: receiptAmount !== null ? yuanToCents(receiptAmount) : null,
    };
  }

  async verifyCallback(
    _headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<CallbackPayload> {
    this.assertConfigured();
    const form = new URLSearchParams(rawBody.toString('utf8'));
    const params: Record<string, string> = {};
    for (const [k, v] of form.entries()) params[k] = v;

    const sign = params.sign;
    if (!sign) throw new Error('支付宝回调缺少 sign');
    // 验签串剔除 sign 与 sign_type（官方规范），其余按 key 升序
    const verifyParams: Record<string, string> = { ...params };
    delete verifyParams.sign;
    delete verifyParams.sign_type;
    if (!rsaSha256Verify(this.loadAlipayPublicKeyPem(), AlipayQrPayAdapter.buildSignString(verifyParams), sign)) {
      throw new Error('支付宝回调验签失败');
    }

    if (!params.out_trade_no) {
      throw new Error('支付宝回调缺少 out_trade_no');
    }
    if (!params.total_amount) {
      throw new Error('支付宝回调缺少 total_amount');
    }
    return {
      orderNo: params.out_trade_no,
      tradeNo: params.trade_no ?? '',
      paid: params.trade_status === 'TRADE_SUCCESS' || params.trade_status === 'TRADE_FINISHED',
      amountCents: yuanToCents(params.total_amount),
    };
  }

  successResponse(): ChannelHttpResponse {
    return { httpStatus: 200, body: 'success', contentType: 'text/plain' };
  }

  failureResponse(_message: string): ChannelHttpResponse {
    return { httpStatus: 200, body: 'failure', contentType: 'text/plain' };
  }
}
