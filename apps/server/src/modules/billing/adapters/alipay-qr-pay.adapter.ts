import { HttpException } from '@nestjs/common';
import type {
  CallbackPayload,
  ChannelHttpResponse,
  ChannelOrderResult,
  ChannelQueryResult,
  PayChannel,
  PayChannelAdapter,
} from '../pay-channel.types.js';

/**
 * 支付宝扫码（当面付 qr_code）适配器 —— **骨架**（批② Task 1 建文件，Task 3 填实现）。
 *
 * 「渠道未配置」语义（brief Step 3）：必需 env 缺失时 `createOrder/queryOrder`
 * 直接抛 `HttpException({code: 2003, message: '支付渠道未配置'}, 503)`。
 * env 清单（`ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY`（应用私钥，加签用）/
 * `ALIPAY_PUBLIC_KEY`（支付宝公钥，验回调签用））为初稿，
 * **以 Task 3 实现时定稿的清单为准**。构造只读 env 存字段、不校验，
 * 缺项判定与真实实现一起在 Task 3 落地；本任务所有方法先按未配置抛 2003。
 *
 * 故意**不加 `@Injectable()`**（CLAUDE.md 的 DI 坑：`NodeJS.ProcessEnv` 参数的
 * `design:paramtypes` 会是 `Object`）；Task 4 接线时用 useFactory 显式构造。
 */
export class AlipayQrPayAdapter implements PayChannelAdapter {
  readonly channel: PayChannel = 'alipay';

  private readonly appId: string | undefined;
  private readonly privateKeyPem: string | undefined;
  private readonly alipayPublicKeyPem: string | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.appId = env.ALIPAY_APP_ID;
    this.privateKeyPem = env.ALIPAY_PRIVATE_KEY;
    this.alipayPublicKeyPem = env.ALIPAY_PUBLIC_KEY;
  }

  /** 必需项是否齐备（Task 3 实现里做缺项判定用；本任务仅让字段有真实读点）。 */
  isConfigured(): boolean {
    return !!this.appId && !!this.privateKeyPem && !!this.alipayPublicKeyPem;
  }

  private notConfigured(): HttpException {
    return new HttpException({ code: 2003, message: '支付渠道未配置' }, 503);
  }

  async createOrder(_input: { orderNo: string; amountCents: number; description: string }): Promise<ChannelOrderResult> {
    throw this.notConfigured();
  }

  async queryOrder(_orderNo: string): Promise<ChannelQueryResult> {
    throw this.notConfigured();
  }

  async verifyCallback(
    _headers: Record<string, string | string[] | undefined>,
    _rawBody: Buffer,
  ): Promise<CallbackPayload> {
    throw this.notConfigured();
  }

  successResponse(): ChannelHttpResponse {
    throw this.notConfigured();
  }

  failureResponse(_message: string): ChannelHttpResponse {
    throw this.notConfigured();
  }
}
