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
 * 微信 Native 扫码支付适配器 —— **骨架**（批② Task 1 建文件，Task 3 填实现）。
 *
 * 「渠道未配置」语义（brief Step 3）：必需 env 缺失时 `createOrder/queryOrder`
 * 直接抛 `HttpException({code: 2003, message: '支付渠道未配置'}, 503)`。
 * env 清单（`WECHAT_PAY_MCHID` / `WECHAT_PAY_APPID` / `WECHAT_PAY_APIV3_KEY` /
 * `WECHAT_PAY_MERCHANT_SERIAL_NO` / `WECHAT_PAY_PRIVATE_KEY`）为初稿，
 * **以 Task 3 实现时定稿的清单为准**。构造只读 env 存字段、不校验，
 * 缺项判定与真实实现一起在 Task 3 落地；本任务所有方法先按未配置抛 2003。
 *
 * 故意**不加 `@Injectable()`**（CLAUDE.md 的 DI 坑：`NodeJS.ProcessEnv` 参数的
 * `design:paramtypes` 会是 `Object`）；Task 4 接线时用 useFactory 显式构造。
 */
export class WechatNativePayAdapter implements PayChannelAdapter {
  readonly channel: PayChannel = 'wechat';

  private readonly mchId: string | undefined;
  private readonly appId: string | undefined;
  private readonly apiV3Key: string | undefined;
  private readonly merchantSerialNo: string | undefined;
  private readonly privateKeyPem: string | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.mchId = env.WECHAT_PAY_MCHID;
    this.appId = env.WECHAT_PAY_APPID;
    this.apiV3Key = env.WECHAT_PAY_APIV3_KEY;
    this.merchantSerialNo = env.WECHAT_PAY_MERCHANT_SERIAL_NO;
    this.privateKeyPem = env.WECHAT_PAY_PRIVATE_KEY;
  }

  /** 必需项是否齐备（Task 3 实现里做缺项判定用；本任务仅让字段有真实读点）。 */
  isConfigured(): boolean {
    return (
      !!this.mchId && !!this.appId && !!this.apiV3Key && !!this.merchantSerialNo && !!this.privateKeyPem
    );
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
