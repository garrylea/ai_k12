import { Controller, Get, UseGuards } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.js';

/**
 * 订阅配额读端点（批①）。角色不设限：student/parent/admin 都可读自己的
 * 订阅状态视图（学生按学生反查家庭、家长按自身，口径在 service 内统一）。
 * 后续批② 的 /plans、/usage 落进同一 controller。
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
}
