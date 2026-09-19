import { Module } from '@nestjs/common';
import { ParentInsightsController } from './parent-insights.controller.js';
import { DashboardService } from './dashboard.service.js';
import { ReportService } from './report.service.js';
import { ErrorsService } from './errors.service.js';
import { ChatLogsService } from './chat-logs.service.js';
import { ParentInsightsRepository } from '../../database/repositories/parent-insights.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { AiDialoguesRepository } from '../../database/repositories/ai-dialogues.repo.js';
import { AiMessagesRepository } from '../../database/repositories/ai-messages.repo.js';
import { ParentModule } from '../parent/parent.module.js';
import { ProgressModule } from '../progress/progress.module.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { StudyTimeService } from './study-time.service.js';
import { ParentAnalyticsRepository } from '../../database/repositories/parent-analytics.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';

/**
 * 家长端「看得见」批（spec `2026-09-18-parent-insights-design.md`）。
 *
 * - `imports: [ParentModule]` —— handler 用 `ParentService.requireOwnedStudent` 做归属校验
 *   （`ParentModule` 已 `exports: [ParentService]`）。
 * - `imports: [ProgressModule]` —— 仪表盘复用 `ProgressService.getStarMap`
 *   （`ProgressModule` 已 `exports: [ProgressService]`；它自带 Content/Practice/Points 依赖，
 *   本模块不必再展开）。
 * - `imports: [AnalyticsModule]` —— `StudyTimeService` 注入 `StudySessionsService`
 *   （`AnalyticsModule` 已 `exports: [StudySessionsService]`）；只把它列进 `providers` 而漏了
 *   `imports`，Nest 会在**启动**时直接报无法解析依赖。
 * - `providers` 必须**逐个列出 service 构造函数里注入的全部仓储**，少一个 Nest 启动就抛
 *   「can't resolve dependencies」。`@Inject('DATABASE_POOL')` 来自 `@Global()` 的
 *   `DatabaseModule`，不需要在这里 import。
 */
@Module({
  imports: [ParentModule, ProgressModule, AnalyticsModule],
  controllers: [ParentInsightsController],
  providers: [
    DashboardService,
    ReportService,
    ErrorsService,
    ChatLogsService,
    StudyTimeService,
    ParentInsightsRepository,
    StudentsRepository,
    SubjectsRepository,
    AiDialoguesRepository,
    AiMessagesRepository,
    ParentAnalyticsRepository,
    ControlsRepository,
  ],
})
export class ParentInsightsModule {}
