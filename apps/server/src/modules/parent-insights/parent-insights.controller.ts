import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { ParentService } from '../parent/parent.service.js';
import { DashboardService } from './dashboard.service.js';
import { ReportService } from './report.service.js';
import { ErrorsService } from './errors.service.js';
import type { ErrorsQuery } from './errors.service.js';
import type { LearningReport, ParentDashboard, ParentErrorPage } from './dto/parent-insights.dto.js';
import type { ReportPeriod } from './window.util.js';
import { DEFAULT_PAGE, parsePositiveInt } from '../points/pagination.util.js';

/** `period` 只认这两个值；非法值**回落 `weekly`**（spec §6：查询类参数宽容回落，不 400）。 */
const PeriodSchema = z.enum(['weekly', 'monthly']);

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
  constructor(
    private readonly parentService: ParentService,
    private readonly dashboardService: DashboardService,
    private readonly reportService: ReportService,
    private readonly errorsService: ErrorsService,
  ) {}

  /** P6.1 家长仪表盘：一次返回名下所有孩子的概览（含各自的按学科卡片）。 */
  @Get('dashboard')
  async getDashboard(@CurrentUser() user: JwtUser): Promise<ParentDashboard> {
    return this.dashboardService.getDashboard(user.sub);
  }

  /** P6.2 学情报告：**实时聚合**，不落 `learning_reports`。 */
  @Get('students/:studentId/reports')
  async getReport(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('period') period?: string,
  ): Promise<LearningReport> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    const parsed = PeriodSchema.safeParse(period);
    return this.reportService.getReport(studentId, (parsed.success ? parsed.data : 'weekly') as ReportPeriod);
  }

  /** P6.3 错题查看（只读）。`pageSize` 服务端固定 20；`page` 非法 → 400/1001。 */
  @Get('students/:studentId/errors')
  async listErrors(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('subject') subject?: string,
    @Query('source') source?: string,
    @Query('track') track?: string,
    @Query('cleared') cleared?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
  ): Promise<ParentErrorPage> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);

    const query: ErrorsQuery = {
      page: parsePositiveInt(page, 'page', DEFAULT_PAGE),
    };
    if (subject !== undefined && /^\d+$/.test(subject)) query.subject = Number(subject);
    if (source) query.source = source;
    if (track === 'main' || track === 'aux') query.track = track;
    if (cleared === 'uncleared' || cleared === 'cleared') query.cleared = cleared;
    if (from) query.from = from;
    if (to) query.to = to;

    return this.errorsService.listErrors(studentId, query);
  }
}
