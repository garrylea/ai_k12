import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { BillingService } from './billing.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';

/**
 * admin 人工兜底（线下收款后补单，spec §5.3）。
 *
 * 与家长端点隔离：路由在 api/admin 下、@Roles('admin')；订单归属不经家长校验
 * （orderNo 全局唯一，归属校验是家长端口的职责，service.adminMarkPaid 只认状态机）。
 * 幂等：已 paid 再打 → service 返回 'duplicate'，这里同样按 200 成功回。
 */
@Controller('api/admin/billing')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminBillingController {
  constructor(private readonly billingService: BillingService) {}

  /** 200：'paid' 与幂等 'duplicate' 对 admin 都是「已入账」。 */
  @Post('orders/:orderNo/mark-paid')
  @HttpCode(200)
  async markPaid(@Param('orderNo') orderNo: string) {
    await this.billingService.adminMarkPaid(orderNo);
    return { orderNo, paymentStatus: 'paid' as const };
  }
}
