import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { OpsAnalyticsService } from './ops-analytics.service.js';

/**
 * 运营分析聚合（admin，母 spec §7 端点 1-2）。
 *
 * 不手工包 `{code, message, data}`——全局 `ResponseInterceptor` 统一包。
 * 窗口参数 `from,to`（YYYY-MM-DD）的校验在 service 的 parseWindow（非法 → 400/1001）。
 * Task 9-11 在此追加其余 9 个端点。
 */
@Controller('api/admin/analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminAnalyticsController {
  constructor(private readonly ops: OpsAnalyticsService) {}

  /** 总览：DAU/WAU、总时长、总答题、正确率、模块 Top5。 */
  @Get('overview')
  @Roles('admin')
  overview(@Query() q: { from?: string; to?: string }) {
    return this.ops.overview(q);
  }

  /** 模块横向对比：人数/时长/答题/正确率。 */
  @Get('modules')
  @Roles('admin')
  modules(@Query() q: { from?: string; to?: string }) {
    return this.ops.modules(q);
  }
}
