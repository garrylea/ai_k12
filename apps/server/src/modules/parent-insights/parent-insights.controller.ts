import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
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
import { GoalsService, GOAL_TEMPLATES } from './goals.service.js';
import { ControlsService } from './controls.service.js';
import type { ControlsUpdatePatch } from './controls.service.js';
import { AlertsService } from './alerts.service.js';
import type { AlertsListQuery } from './alerts.service.js';
import type { StudyTimeSummary, TodayUsageSummary } from './dto/parent-insights.dto.js';
import type {
  GoalAttainmentItem,
  GoalAttainmentSummary,
  LearningReport,
  MasterySummary,
  ParentAlertPage,
  ParentChatLogDetail,
  ParentChatLogPage,
  ParentControls,
  ParentDashboard,
  ParentErrorPage,
  ParentUnreadAlerts,
  SpecialsSummary,
} from './dto/parent-insights.dto.js';
import type { GoalMetric } from '../../database/repositories/goals.repo.js';
import type { ReportPeriod } from './window.util.js';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  parseOptionalPositiveInt,
  parsePositiveInt,
} from '../points/pagination.util.js';

/** `period` 只认这两个值；非法值**回落 `weekly`**（spec §6：查询类参数宽容回落，不 400）。 */
const PeriodSchema = z.enum(['weekly', 'monthly']);

/**
 * 目标维度白名单 —— **从 `GOAL_TEMPLATES` 派生**，不手抄。
 * 手抄必然在某次加指标时漏掉（1B 就出现过「枚举加了、白名单没加」的隐患），模板是唯一真源。
 */
const GOAL_METRICS: readonly GoalMetric[] = GOAL_TEMPLATES.map((t) => t.metric);

/**
 * `PUT .../goals/:metric` 的 body。
 *
 * 2026-09-20（P6.5）起 `subjectId` **必填**：所有目标都按学科（不存在全局目标），
 * 所以一条路径参数不够定位资源 —— 用 body 带学科，避免再加一条同深度模板路径。
 * `period`/`title` 由服务端按 metric 派生，家长无从自定义。
 * 上限 9999 与 points 规则值同一档，顺带挡住 `SMALLINT` 溢出；**下限 1**：目标 0 没有意义
 * （达成率永远是 null）。
 */
const UpsertGoalSchema = z.object({
  target: z.number().int().min(1).max(9999),
  subjectId: z.number().int().positive(),
});

/**
 * `PUT .../controls` 的 body（spec §4.2/§5.6）：三个字段**均可选**；两个预警阈值 `1..180`、
 * 单次学习锁定 `1..480`（或 `null` = 解除），都是整数。
 *
 * 越界在这里就 `409`/`1001`（**不是** Zod 默认的 400）——spec §4.2 的校验链把范围越界
 * 与「没有要更新的字段」并列成 409。`ControlsService` 里还有一道同样的范围校验，
 * 那是服务层的最后防线（controller 直连服务的调用方绕过 schema 时仍能拦住）。
 */
const ControlsPatchSchema = z.object({
  alertAwayMinutes: z.number().int().min(1).max(180).optional(),
  alertIdleMinutes: z.number().int().min(1).max(180).optional(),
  // null 必须显式允许（解除设置），故用 .nullable() 而不是 .nullish()——
  // nullish 会让 undefined 也通过，虽然语义上等价，但显式写更清楚。
  sessionLockMinutes: z.number().int().min(1).max(480).nullable().optional(),
});

/** `GET alerts` 的 `pageSize` 上界（spec §4.3：1..50，与其它分页端点不同的档）。 */
const ALERTS_MAX_PAGE_SIZE = 50;

/**
 * 家长端「看得见」批（spec `2026-09-18-parent-insights-design.md`）。
 *
 * 与 `ParentController` 同前缀 `api/parent`（Nest 允许多个 controller 共前缀，
 * `ParentPointsController` 已是先例）。写端点有：`PUT students/:studentId/goals/:metric`
 * （家长改目标值，只允许改 `target`，`metric`/`period`/`title` 由服务端派生）、
 * `PUT students/:studentId/controls`（预警灵敏度）与 `PATCH alerts/:alertId/read`。
 * 新增路径**不得与 `ParentController` 撞车**（同前缀，撞了会静默覆盖）。
 *
 * 归属校验：按学生的端点第一行 `await this.parentService.requireOwnedStudent(user.sub, studentId)`。
 * 三个例外：`dashboard` 按 `parentId` 查自己名下全部孩子；`GET alerts` 只在**传了
 * `studentId`** 时校验（不传 = 看全部孩子）；`PATCH alerts/:alertId/read` 没有 `studentId`，
 * 它的归属校验（`alert.parent_id === parentId`）只能放在 `AlertsService` 里——要先 `findById`。
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
    private readonly controlsService: ControlsService,
    private readonly alertsService: AlertsService,
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

  /** 今日已用时长（spec §8.2）——**纯统计**：不再与任何「每日上限」比较（该概念 2026-09-23 已废除）。 */
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
    const { subjectId, target } = parsed.data;

    // 「指标 × 学科」必须匹配（如 daily_words 只适用英语）。规则真源在 GoalsService 里，别在这儿复制。
    if (!(await this.goalsService.isMetricAllowedForSubject(subjectId, metric as GoalMetric))) {
      throw new BadRequestException({
        code: 1001,
        message: `${metric} 不适用于该学科（学科 ${subjectId}）`,
      });
    }
    // 只能给「在学学科」设目标：否则会给一门孩子根本没在学的课写目标，家长在页面上也看不到它。
    if (!(await this.goalsService.isLearningSubject(studentId, subjectId))) {
      throw new BadRequestException({
        code: 1001,
        message: `学科 ${subjectId} 不是这个孩子的在学学科（先去「学生账号 → 配置教材」）`,
      });
    }
    return this.goalsService.upsertTarget(studentId, subjectId, metric as GoalMetric, target);
  }

  /**
   * 行为管控 —— 读预警灵敏度（spec §4.1）。响应**只有两个阈值**，兑换状态不在这里
   * （前端另调 `GET .../points/settings`，避免同一字段两个归属）。
   */
  @Get('students/:studentId/controls')
  async getControls(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
  ): Promise<ParentControls> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.controlsService.get(studentId);
  }

  /**
   * 行为管控 —— 改预警灵敏度（spec §4.2）。至少一个字段、范围 1..180，越界 409/1001；
   * 合法则回读并返回完整对象。
   */
  @Put('students/:studentId/controls')
  async putControls(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Body() body: unknown,
  ): Promise<ParentControls> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    const parsed = ControlsPatchSchema.safeParse(body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
      throw new ConflictException({ code: 1001, message: `入参校验失败：${detail}` });
    }
    return this.controlsService.update(studentId, parsed.data as ControlsUpdatePatch);
  }

  /**
   * 未读预警轮询（spec §3.3，家长端 Banner 30s 一次）。家长维度、不看单个孩子，
   * 因此**不做** `requireOwnedStudent`；service 内部先对名下全部孩子跑 `closeStale`
   * 补判（失败只 warn）。空结果是正常态。
   */
  @Get('alerts/unread')
  async listUnreadAlerts(@CurrentUser() user: JwtUser): Promise<ParentUnreadAlerts> {
    return this.alertsService.unread(user.sub);
  }

  /**
   * 预警中心列表（spec §4.3）。`studentId` 缺省 = 全部孩子；给了就先校验归属。
   * 空结果是正常态（`items: []` / `total: 0`），不是错误。
   */
  @Get('alerts')
  async listAlerts(
    @CurrentUser() user: JwtUser,
    @Query('studentId') studentId?: string,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<ParentAlertPage> {
    const query: AlertsListQuery = {
      page: parsePositiveInt(page, 'page', DEFAULT_PAGE),
      pageSize: parsePositiveInt(pageSize, 'pageSize', DEFAULT_PAGE_SIZE, ALERTS_MAX_PAGE_SIZE),
    };
    // `studentId` 可选：空串等同「没传」（spec §4.3）。用 `parseOptionalPositiveInt` 而不是
    // `parsePositiveInt(..., 默认值)` —— 后者必须给个 number 默认值，而任何 number 都可能是
    // 合法学生 id（`1` 尤其），空串会静默变成「按 1 号孩子筛选」。返回 `undefined` 的语义是
    // 「不过滤」，与「按某个孩子过滤」在类型上就分得开。
    const ownedStudentId = parseOptionalPositiveInt(studentId, 'studentId');
    if (ownedStudentId !== undefined) {
      query.studentId = ownedStudentId;
      await this.parentService.requireOwnedStudent(user.sub, ownedStudentId);
    }
    // 只认 `'1'` 为真（spec §4.3）
    if (unreadOnly === '1') query.unreadOnly = true;
    return this.alertsService.list(user.sub, query);
  }

  /**
   * 标记预警已读（spec §4.4）。`alertId` **不走 `ParseIntPipe`**：spec 要求非正整数
   * 也回 409/1001，而 pipe 会先抛 400。正整数/存在/归属三段校验都在 `AlertsService`。
   * 幂等：重复标记不报错。
   */
  @Patch('alerts/:alertId/read')
  async markAlertRead(
    @CurrentUser() user: JwtUser,
    @Param('alertId') alertId: string,
  ): Promise<null> {
    await this.alertsService.markRead(user.sub, alertId);
    return null;
  }
}
