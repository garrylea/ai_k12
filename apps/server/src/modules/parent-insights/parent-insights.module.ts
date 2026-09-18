import { Module } from '@nestjs/common';
import { ParentInsightsController } from './parent-insights.controller.js';
import { DashboardService } from './dashboard.service.js';
import { ReportService } from './report.service.js';
import { ParentInsightsRepository } from '../../database/repositories/parent-insights.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { ParentModule } from '../parent/parent.module.js';
import { ProgressModule } from '../progress/progress.module.js';

/**
 * 家长端「看得见」批（spec `2026-09-18-parent-insights-design.md`）。
 *
 * - `imports: [ParentModule]` —— handler 用 `ParentService.requireOwnedStudent` 做归属校验
 *   （`ParentModule` 已 `exports: [ParentService]`）。
 * - `imports: [ProgressModule]` —— 仪表盘复用 `ProgressService.getStarMap`
 *   （`ProgressModule` 已 `exports: [ProgressService]`；它自带 Content/Practice/Points 依赖，
 *   本模块不必再展开）。
 * - `providers` 必须**逐个列出 service 构造函数里注入的全部仓储**，少一个 Nest 启动就抛
 *   「can't resolve dependencies」。`@Inject('DATABASE_POOL')` 来自 `@Global()` 的
 *   `DatabaseModule`，不需要在这里 import。
 */
@Module({
  imports: [ParentModule, ProgressModule],
  controllers: [ParentInsightsController],
  providers: [
    DashboardService,
    ReportService,
    ParentInsightsRepository,
    StudentsRepository,
    SubjectsRepository,
  ],
})
export class ParentInsightsModule {}
