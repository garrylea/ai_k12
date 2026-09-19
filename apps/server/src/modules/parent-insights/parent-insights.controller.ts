import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Put,
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
import { ChatLogsService } from './chat-logs.service.js';
import type { ChatLogsQuery } from './chat-logs.service.js';
import { StudyTimeService } from './study-time.service.js';
import { SpecialsService } from './specials.service.js';
import { ParentMasteryService } from './parent-mastery.service.js';
import { GoalsService } from './goals.service.js';
import type { StudyTimeSummary, TodayUsageSummary } from './dto/parent-insights.dto.js';
import type {
  GoalAttainmentItem,
  GoalAttainmentSummary,
  LearningReport,
  MasterySummary,
  ParentChatLogDetail,
  ParentChatLogPage,
  ParentDashboard,
  ParentErrorPage,
  SpecialsSummary,
} from './dto/parent-insights.dto.js';
import type { GoalMetric } from '../../database/repositories/goals.repo.js';
import type { ReportPeriod } from './window.util.js';
import { DEFAULT_PAGE, parsePositiveInt } from '../points/pagination.util.js';

/** `period` 只认这两个值；非法值**回落 `weekly`**（spec §6：查询类参数宽容回落，不 400）。 */
const PeriodSchema = z.enum(['weekly', 'monthly']);

/** 目标维度白名单（与 `goals.metric` 的列注释、`GoalMetric` 类型逐字一致）。 */
const GOAL_METRICS: readonly GoalMetric[] =
  ['daily_study_minutes', 'daily_words', 'weekly_passages', 'weekly_clear_errors'];

/**
 * `PUT .../goals/:metric` 的 body。**只收 `target`**：`metric` 在路径里、`period`/`title`
 * 由服务端按 metric 派生，家长无从自定义。上限 9999 与 points 规则值同一档，顺带挡住
 * `SMALLINT` 溢出；**下限 1**：目标 0 没有意义（达成率永远是 null）。
 */
const UpsertGoalSchema = z.object({ target: z.number().int().min(1).max(9999) });

/**
 * 家长端「看得见」批（spec `2026-09-18-parent-insights-design.md`）。
 *
 * 与 `ParentController` 同前缀 `api/parent`（Nest 允许多个 controller 共前缀，
 * `ParentPointsController` 已是先例）。`GET` 端点全部只读；**唯一的写端点是
 * `PUT students/:studentId/goals/:metric`**（家长改目标值）——它同样先做归属校验，
 * 且只允许改 `target`，`metric`/`period`/`title` 由服务端派生。
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
    private readonly chatLogsService: ChatLogsService,
    private readonly studyTimeService: StudyTimeService,
    private readonly specialsService: SpecialsService,
    private readonly parentMasteryService: ParentMasteryService,
    private readonly goalsService: GoalsService,
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
    if (track === 'main' || track === 'training') query.track = track;
    if (cleared === 'uncleared' || cleared === 'cleared') query.cleared = cleared;
    if (from) query.from = from;
    if (to) query.to = to;

    return this.errorsService.listErrors(studentId, query);
  }

  /** P6.4 对话回放列表。筛选 = 轨道 + 场景 + 时间 + 标题关键词（无学科，见 service 注释）。 */
  @Get('students/:studentId/chat-logs')
  async listChatLogs(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('track') track?: string,
    @Query('scene') scene?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
  ): Promise<ParentChatLogPage> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);

    const query: ChatLogsQuery = { page: parsePositiveInt(page, 'page', DEFAULT_PAGE) };
    if (track === 'mainline' || track === 'auxiliary') query.track = track;
    if (scene) query.scene = scene;
    if (from) query.from = from;
    if (to) query.to = to;
    if (q) query.q = q;

    return this.chatLogsService.listChatLogs(studentId, query);
  }

  /** P6.4 单条对话详情（逐句回放，含 `reasoning` 与闲聊标记）。 */
  @Get('students/:studentId/chat-logs/:dialogueId')
  async getChatLog(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Param('dialogueId', ParseIntPipe) dialogueId: number,
  ): Promise<ParentChatLogDetail> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.chatLogsService.getChatLog(studentId, dialogueId);
  }

  /**
   * 学习时长（spec §8.2）。`from`/`to` 形如 `YYYY-MM-DD`，缺省近 7 天；
   * 非法值**宽容回落**默认窗口，不 400（与 `period` 的处理一致）。
   *
   * ⚠️ 这个端点的数字与 `dashboard` 里的 `activeDays7` 是**两套口径**（spec §10）。
   * 不要为了「看起来一致」把任何一个改掉。
   */
  @Get('students/:studentId/study-time')
  async getStudyTime(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<StudyTimeSummary> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.studyTimeService.getStudyTime(studentId, from, to);
  }

  /** 今日已用时长（spec §8.2）——用于和 `controls.daily_time_limit_minutes` 比较。 */
  @Get('students/:studentId/today-usage')
  async getTodayUsage(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
  ): Promise<TodayUsageSummary> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.studyTimeService.getTodayUsage(studentId);
  }

  /**
   * 专项学情（spec §8.2，埋点 Phase 1B）：四个专项模块的窗口内聚合。
   * `from`/`to` 由 `resolveRange` 宽容回落（非法值不 400），与 `study-time` 同一口径。
   */
  @Get('students/:studentId/specials')
  async getSpecials(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<SpecialsSummary> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.specialsService.getSpecials(studentId, from, to);
  }

  /**
   * 真掌握度（spec §8.2，埋点 Phase 1B）。
   *
   * `limit` 走 `parsePositiveInt`：**越界 400，不静默钳制**（本仓全局纪律）。缺省 10、上限 50。
   */
  @Get('students/:studentId/mastery')
  async getMastery(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('limit') limit?: string,
  ): Promise<MasterySummary> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.parentMasteryService.getMastery(studentId, parsePositiveInt(limit, 'limit', 10, 50));
  }

  /** 目标达成（spec §8.2，埋点 Phase 1B）：首次调用会懒初始化四个默认目标（只补缺失）。 */
  @Get('students/:studentId/goals/attainment')
  async getGoalAttainment(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
  ): Promise<GoalAttainmentSummary> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.goalsService.getAttainment(studentId);
  }

  /**
   * 家长改目标值（本批唯一的写端点）。响应回**该 metric 的最新达成情况**，
   * 前端拿它原地替换行数据，不必再发一次 GET（省一次往返，也避免写后读不一致的窗口）。
   *
   * ⚠️ **路径撞车的历史遗留**：API 设计文档与 `openapi.yaml` 里记着 4 个旧的 goals CRUD
   * （`GET/POST /goals`、`PATCH/DELETE /goals/{goalId}`），那 4 个端点**从来没有实现过**
   * （2026-09-22 实测：启动日志里只有本文件的路由，全仓没有对应 handler）。它们更**没有
   * `metric` 维度**，所以本端点不是「覆盖旧实现」而是**第一个真正落地的目标写端点**；
   * 两份文档里的旧条目由 Task 12 标废弃（连路径撞车都不成立——那边只有文档、没有路由）。
   *
   * 错误码：`metric` 不在白名单 → 400/1001；body 校验失败 → 400/1001；
   * 不是自己孩子 → 403/1005；孩子不存在 → 404/1002（都由 `requireOwnedStudent` 抛）。
   */
  @Put('students/:studentId/goals/:metric')
  async putGoalTarget(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Param('metric') metric: string,
    @Body() body: unknown,
  ): Promise<GoalAttainmentItem> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    if (!GOAL_METRICS.includes(metric as GoalMetric)) {
      throw new BadRequestException({
        code: 1001,
        message: `metric 仅允许 ${GOAL_METRICS.join(' | ')}（收到 ${metric}）`,
      });
    }
    const parsed = UpsertGoalSchema.safeParse(body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
      throw new BadRequestException({ code: 1001, message: `入参校验失败：${detail}` });
    }
    return this.goalsService.upsertTarget(studentId, metric as GoalMetric, parsed.data.target);
  }
}
