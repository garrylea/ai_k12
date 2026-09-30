import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { BillingService } from './billing.service.js';
import { SubscriptionsService } from './subscriptions.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';

/**
 * admin 人工兜底（线下收款后补单，spec §5.3）。
 *
 * 与家长端点隔离：路由在 api/admin 下、@Roles('admin')；订单归属不经家长校验
 * （orderNo 全局唯一，归属校验是家长端口的职责，service.adminMarkPaid 只认状态机）。
 * 幂等：已 paid 再打 → service 返回 'duplicate'，这里同样按 200 成功回。
 * 审计：操作人（JWT sub）透传给 service，由 service logger.log 留痕（2026-09-30 方案 A）。
 */
@Controller('api/admin/billing')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminBillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  /**
   * 待裁决列表（批④ Task 3）：claim_status 过滤（缺省 pending_review）、claimed_at 倒序。
   * **路由顺序**：`orders/claims` 字面路径必须声明在下方 `orders/:orderNo/...` 参数路由之前
   * （Nest 按方法声明顺序注册与匹配，别被参数路由吞掉）。
   */
  @Get('orders/claims')
  listClaims(
    @Query('status') status: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
  ) {
    // query 进来是 string；status 缺省/非法与 page/pageSize 越界校验全在 service（400/1001 不钳制）
    return this.billingService.listClaims(
      status,
      page != null ? Number(page) : undefined,
      pageSize != null ? Number(pageSize) : undefined,
    );
  }

  /** 200：'paid' 与幂等 'duplicate' 对 admin 都是「已入账 + claim 已 approved」。 */
  @Post('orders/:orderNo/claims/approve')
  @HttpCode(200)
  async approveClaim(@Param('orderNo') orderNo: string, @CurrentUser() user: JwtUser) {
    const result = await this.billingService.approveClaim(orderNo, user.sub);
    return { orderNo, paymentStatus: 'paid' as const, result };
  }

  /** 驳回：claim → rejected，reason 追加进 claim_note（截断 200，service 口径）。 */
  @Post('orders/:orderNo/claims/reject')
  @HttpCode(200)
  async rejectClaim(
    @Param('orderNo') orderNo: string,
    @Body() body: { reason?: string } | undefined,
    @CurrentUser() user: JwtUser,
  ) {
    const reason = typeof body?.reason === 'string' ? body.reason : undefined;
    await this.billingService.rejectClaim(orderNo, user.sub, reason);
    return { orderNo, claimStatus: 'rejected' as const };
  }

  /** 200：'paid' 与幂等 'duplicate' 对 admin 都是「已入账」。 */
  @Post('orders/:orderNo/mark-paid')
  @HttpCode(200)
  async markPaid(@Param('orderNo') orderNo: string, @CurrentUser() user: JwtUser) {
    await this.billingService.adminMarkPaid(orderNo, user.sub);
    return { orderNo, paymentStatus: 'paid' as const };
  }

  // ---------- 家庭订阅管理（批④ Task 5，spec §2.3） ----------
  // 路由前缀 families/ 与上方 orders/ 无交集，无声明顺序敏感问题。

  /** 家庭订阅列表：keyword 匹配家长手机号/昵称；分页校验在 service（400/1001 不钳制）。 */
  @Get('families')
  listFamilies(
    @Query('keyword') keyword: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
  ) {
    return this.subscriptionsService.listFamilies(
      keyword,
      page != null ? Number(page) : undefined,
      pageSize != null ? Number(pageSize) : undefined,
    );
  }

  /**
   * 设定试用截止（null=收回）→ 200 StatusView（写后新读）。
   * body.trialEndsAt 键必须存在（null 是合法值，缺键与「收回」语义不同，不静默兜底）。
   */
  @Put('families/:parentId/trial')
  async setFamilyTrial(
    @Param('parentId', ParseIntPipe) parentId: number,
    @Body() body: { trialEndsAt?: string | null } | undefined,
    @CurrentUser() user: JwtUser,
  ) {
    if (body == null || body.trialEndsAt === undefined) {
      throw new BadRequestException({ code: 1001, message: 'trialEndsAt 必填（ISO 字符串或 null）' });
    }
    return this.subscriptionsService.adminSetTrial(parentId, body.trialEndsAt, user.sub);
  }

  /** 赠送 / 扣减订阅天数（正负号即方向）→ 200 StatusView；days=0/非整数由 service 400/1001。 */
  @Post('families/:parentId/grant')
  @HttpCode(200)
  async grantFamilyDays(
    @Param('parentId', ParseIntPipe) parentId: number,
    @Body() body: { days?: number; reason?: string } | undefined,
    @CurrentUser() user: JwtUser,
  ) {
    return this.subscriptionsService.adminGrantDays(parentId, body?.days, body?.reason, user.sub);
  }
}
