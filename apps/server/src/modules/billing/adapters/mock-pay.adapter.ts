import type {
  CallbackPayload,
  ChannelHttpResponse,
  ChannelOrderResult,
  ChannelQueryResult,
  PayChannelAdapter,
} from '../pay-channel.types.js';

/**
 * Mock 支付适配器（测试 / 无商户号环境兜底，brief Step 2）。
 *
 * - `createOrder` 返回固定形态的 mock 单；`queryOrder` 按构造开关 `autoPaid`
 *   返回已/未支付；`verifyCallback` 直接解析 rawBody JSON（模拟渠道回调时由
 *   测试自己构造 `{orderNo, tradeNo, paid, amountCents}`）。
 * - 故意**不加 `@Injectable()`**：构造参数是布尔原语，`emitDecoratorMetadata`
 *   会把它标成 `Object`，Nest 按 token 找不到会启动失败（CLAUDE.md 的 DI 坑）。
 *   Task 4 接线时以显式 provider / useFactory 注册即可，零依赖类不需要装饰器。
 * - 选用开关在 BillingService（`NODE_ENV==='test'` 或 `BILLING_USE_MOCK==='1'`），
 *   本文件不读 env（Task 2 接线）。
 */
export class MockPayAdapter implements PayChannelAdapter {
  readonly channel = 'mock' as const;

  constructor(private readonly autoPaid: boolean = true) {}

  async createOrder(input: { orderNo: string; amountCents: number; description: string }): Promise<ChannelOrderResult> {
    return { tradeNo: `MOCK-${input.orderNo}`, qrContent: `mock://pay/${input.orderNo}`, redirectUrl: null };
  }

  async queryOrder(orderNo: string): Promise<ChannelQueryResult> {
    return { paid: this.autoPaid, tradeNo: `MOCK-${orderNo}`, amountCents: null };
  }

  async verifyCallback(
    _headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<CallbackPayload> {
    return JSON.parse(rawBody.toString('utf8')) as CallbackPayload;
  }

  successResponse(): ChannelHttpResponse {
    return { httpStatus: 200, body: JSON.stringify({ code: 'SUCCESS' }), contentType: 'application/json' };
  }

  failureResponse(message: string): ChannelHttpResponse {
    return { httpStatus: 500, body: JSON.stringify({ code: 'FAIL', message }), contentType: 'application/json' };
  }
}
