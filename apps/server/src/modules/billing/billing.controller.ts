import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { BillingService } from './billing.service.js';
import { SubscriptionsService } from './subscriptions.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';

/**
 * 家长端订单端点（spec §5.2，批② Task 5）。
 *
 * 薄层：归属（1005）/ 状态机（2002）/ 渠道（2003/2004）全在 BillingService，
 * controller 只做身份透传与查询参数的 string → number 转换（越界校验也归 service，
 * 400/1001 不钳制——仓规）。
 *
 * 状态码口径：`POST /orders` 是唯一创建端点，走 Nest @Post 默认 201；
 * 其余 POST（cancel / confirm-paid / ack）是状态迁移，显式 @HttpCode(200)。
 */
@Controller('api/billing')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('parent')
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  /** 201（Nest @Post 默认）：返回 OrderView（复用 pending 单时也是 201）。 */
  @Post('orders')
  createOrder(
    @Body() body: { planCode?: string; channel?: string },
    @CurrentUser() user: JwtUser,
  ) {
    // 非 string 的 planCode 归一为空串，让 service 走 2005（套餐不存在）而非 SQL 500
    const planCode = typeof body?.planCode === 'string' ? body.planCode : '';
    const channel = typeof body?.channel === 'string' ? body.channel : '';
    return this.billingService.createOrder(user.sub, { planCode, channel });
  }

  @Get('orders')
  listOrders(
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @CurrentUser() user: JwtUser,
  ) {
    // query 进来是 string；非法值（NaN/0）由 service 统一 400/1001
    return this.billingService.listOrders(
      user.sub,
      page != null ? Number(page) : undefined,
      pageSize != null ? Number(pageSize) : undefined,
    );
  }

  @Get('orders/:orderNo')
  getOrder(@Param('orderNo') orderNo: string, @CurrentUser() user: JwtUser) {
    return this.billingService.getOrder(user.sub, orderNo);
  }

  @Post('orders/:orderNo/cancel')
  @HttpCode(200)
  cancel(@Param('orderNo') orderNo: string, @CurrentUser() user: JwtUser) {
    // 归属与状态校验都在 service（requireOwnedOrder + 状态机）
    return this.billingService.cancel(user.sub, orderNo);
  }

  /**
   * 「我已付款」兜底。body 可带 note（≤200，超长由 service 400/1001）——查单未确认时
   * 存入 claim_note 供 admin 裁决参考。service 返回 'paid' | 'duplicate'（并发已入账），
   * 两者对前端都是已支付；claimStatus 随 2004 错误体（pending_review）或成功响应体透传；
   * currentPeriodEnd 从订阅状态视图取，供支付成功页直接展示。
   */
  @Post('orders/:orderNo/confirm-paid')
  @HttpCode(200)
  async confirmPaid(
    @Param('orderNo') orderNo: string,
    @Body() body: { note?: string } | undefined,
    @CurrentUser() user: JwtUser,
  ) {
    const note = typeof body?.note === 'string' ? body.note : undefined;
    const { claimStatus } = await this.billingService.confirmPaid(user.sub, orderNo, note);
    const status = await this.subscriptionsService.getStatusView({ role: 'parent', sub: user.sub });
    return { orderNo, paymentStatus: 'paid' as const, claimStatus, currentPeriodEnd: status.currentPeriodEnd };
  }

  /** 家长未读裁决通知（spec §2.3）：跨页提示条数据源，挂载 + 30s 轮询拉取。 */
  @Get('notices/unread')
  listUnreadNotices(@CurrentUser() user: JwtUser) {
    return this.billingService.listUnreadNotices(user.sub);
  }

  /** 「知道了」标已读。幂等；显式 200（状态迁移语义，与 cancel/confirm-paid 同口径）。 */
  @Post('notices/:id/ack')
  @HttpCode(200)
  ackNotice(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.billingService.ackNotice(user.sub, id);
  }
}
