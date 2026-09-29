import {
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { BillingService } from './billing.service.js';
import type { ChannelHttpResponse } from './pay-channel.types.js';

/**
 * 渠道异步回调（spec §5.2 POST /api/billing/callback/{channel}）。
 *
 * **免 JWT**：渠道服务器不带我们的 token，本 controller 不挂 JwtAuthGuard/RolesGuard
 * （也没有 @CurrentUser 可用）。安全性靠 service 里适配器的验签 + 找单 + 串单 + 金额四道闸。
 *
 * - `@HttpCode(200)`：Nest @Post 默认 201，渠道应答约定是 200。
 * - `main.ts` 开了 `rawBody: true`，`req.rawBody!` 是验签必需的原始字节（微信验签串、
 *   支付宝原文验签都不能用重序列化后的 body）。
 * - 用 `@Res()` 直写响应（httpStatus/body/contentType 来自适配器），**跳过响应包装
 *   拦截器**——渠道应答必须是裸 JSON/文本，不能包 `{code,data}` 壳。
 */
@Controller('api/billing/callback')
export class BillingCallbackController {
  constructor(private readonly billingService: BillingService) {}

  @Post(':channel')
  @HttpCode(200)
  async handleCallback(
    @Param('channel') channel: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    // 渠道白名单在 controller 侧拦：'mock' 不是真实渠道、其他未知渠道没有适配器
    // 也就没有它的应答格式，404/1002 拒掉（不进 service）。
    if (channel !== 'wechat' && channel !== 'alipay') {
      res.status(404).type('application/json').send(JSON.stringify({ code: 1002, message: '未知支付渠道' }));
      return;
    }
    const reply: ChannelHttpResponse = await this.billingService.handleCallback(
      channel,
      headers,
      req.rawBody!,
    );
    res.status(reply.httpStatus).type(reply.contentType).send(reply.body);
  }
}
