/**
 * 支付渠道抽象（批② Task 1）。
 *
 * `PayChannel` 在 brief 的 `'wechat' | 'alipay'` 基础上追加了 `'mock'`：
 * MockPayAdapter 也要 `implements PayChannelAdapter`，接口要求 `channel: PayChannel`，
 * 硬编码成 'wechat' 会把 mock 订单伪装成微信渠道；'mock' 仅在
 * `NODE_ENV==='test'` 或 `BILLING_USE_MOCK==='1'` 时被选用（Task 2 接线），
 * 真实下单只会出现 'wechat' | 'alipay'（订单落库的 channel 校验由 Task 2 负责）。
 */
export type PayChannel = 'wechat' | 'alipay' | 'mock';

export interface ChannelOrderResult {
  tradeNo: string;          // 渠道交易号/预下单号
  qrContent: string | null; // 二维码内容（code_url / qr_code）
  redirectUrl: string | null; // 支付宝跳转形态降级用
}

export interface ChannelQueryResult {
  paid: boolean;
  tradeNo: string | null;
  amountCents: number | null;
}

export interface CallbackPayload {
  orderNo: string;      // 商户单号 out_trade_no
  tradeNo: string;      // 渠道交易号
  paid: boolean;        // trade_state/TRADE_SUCCESS 判定
  amountCents: number;
}

export interface ChannelHttpResponse { httpStatus: number; body: string; contentType: string }

export interface PayChannelAdapter {
  channel: PayChannel;
  createOrder(input: { orderNo: string; amountCents: number; description: string }): Promise<ChannelOrderResult>;
  queryOrder(orderNo: string): Promise<ChannelQueryResult>;
  verifyCallback(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<CallbackPayload>;
  successResponse(): ChannelHttpResponse;   // 微信 200 {"code":"SUCCESS"}；支付宝 200 "success"
  failureResponse(message: string): ChannelHttpResponse; // 微信 500 {"code":"FAIL"}；支付宝 200 "failure"
}
