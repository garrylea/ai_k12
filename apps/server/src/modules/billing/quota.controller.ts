import { Controller, Get, UseGuards } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';

/**
 * 订阅配额读端点（批① /subscription + 批② /plans、/usage）。
 *
 * - `/subscription` 角色不设限：student/parent/admin 都可读自己的订阅状态视图
 *   （学生按学生反查家庭、家长按自身，口径在 service 内统一）。
 * - `/plans` 同样三角色可读（套餐目录是公共信息）。
 * - `/usage` 仅家长：AI 用量是家长付费视角的聚合数据，handler 级 `@Roles('parent')`
 *   （类上不能挂——会连坐前两个端点），学生 token → RolesGuard 403。
 */
@Controller('api/quota')
@UseGuards(JwtAuthGuard, RolesGuard)
export class QuotaController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get('subscription')
  getSubscription(@CurrentUser() user: JwtUser) {
    // 身份完全来自 JWT；响应包装由既有拦截器处理。
    return this.subscriptionsService.getStatusView(user);
  }

  @Get('plans')
  listPlans() {
    return this.subscriptionsService.listPlans();
  }

  @Get('usage')
  @Roles('parent')
  getUsage(@CurrentUser() user: JwtUser) {
    // 家长视角：JWT sub 即 parent_id，聚合其名下所有学生。
    return this.subscriptionsService.getUsageView(user.sub);
  }
}
