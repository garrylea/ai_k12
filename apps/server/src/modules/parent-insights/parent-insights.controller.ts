import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { DashboardService } from './dashboard.service.js';
import type { ParentDashboard } from './dto/parent-insights.dto.js';

/**
 * 家长端「看得见」批（spec `2026-09-18-parent-insights-design.md`）。
 *
 * 与 `ParentController` 同前缀 `api/parent`（Nest 允许多个 controller 共前缀，
 * `ParentPointsController` 已是先例）。全部端点**只读**。
 *
 * 归属校验：除 `dashboard`（按 `parentId` 查自己名下全部孩子）外，每个 handler 第一行必须
 * `await this.parentService.requireOwnedStudent(user.sub, studentId)`（Task 9/10 的端点）。
 *
 * 不手工包 `{code, message, data}`——全局 `ResponseInterceptor` 统一包。
 */
@Controller('api/parent')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('parent')
export class ParentInsightsController {
  constructor(private readonly dashboardService: DashboardService) {}

  /** P6.1 家长仪表盘：一次返回名下所有孩子的概览（含各自的按学科卡片）。 */
  @Get('dashboard')
  async getDashboard(@CurrentUser() user: JwtUser): Promise<ParentDashboard> {
    return this.dashboardService.getDashboard(user.sub);
  }
}
