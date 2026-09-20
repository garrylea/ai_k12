import { Module } from '@nestjs/common';
import { LlmCallLogsRepository } from '../../database/repositories/llm-call-logs.repo.js';
import { ApiRequestLogsRepository } from '../../database/repositories/api-request-logs.repo.js';
import { StudySessionsRepository } from '../../database/repositories/study-sessions.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import { SafetyAlertsModule } from '../safety/safety-alerts.module.js';
import { TelemetryService } from './telemetry.service.js';
import { StudySessionsService } from './study-sessions.service.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsInterceptor } from '../../common/interceptors/analytics.interceptor.js';
import { setLlmCallSink } from '../../ai-core/infra/llm-call-log.js';

/**
 * 埋点模块。
 *
 * - Phase 0（账本 + 请求日志）：两个 buffer + `AnalyticsInterceptor`，sink 在这里接上。
 * - Phase 1A（学习时长）：`study_sessions` 的采集端点。
 *
 * 为什么把 sink 注册放这里：capability 是零参 `new` 出来的、拿不到 DI 容器
 * （见 CLAUDE.md 的 DI 坑），所以 ai-core 用模块级 sink 单例，由本模块在启动时接上。
 *
 * `SUBJECTS_REPO_FOR_ANALYTICS` 这个 token：`StudySessionsService` 的第二个构造参数是
 * **接口** `SubjectsRepoLike`，按仓库的 DI 坑必须显式 `@Inject(token)`，否则 Nest 会把
 * `design:paramtypes` 写成 `Object` 并启动失败。用 `useExisting` 复用同一个 SubjectsRepository。
 *
 * 走神预警（2026-09-20，P6.9）：`SafetyAlertsService` 由 `SafetyAlertsModule` **导出后复用**
 * （绝不在本模块重复 provide，否则会分裂实例与去重语义）；`ControlsRepository` 是本地 provider
 * （家长可调的预警灵敏度两个阈值，心跳路径按学生读）。
 */
@Module({
  imports: [SafetyAlertsModule],
  controllers: [AnalyticsController],
  providers: [
    LlmCallLogsRepository,
    ApiRequestLogsRepository,
    // TelemetryService 必须留在 providers：本模块构造函数与 AnalyticsInterceptor 都注入它，
    // 且全仓无第二个 provider，删掉会在启动时直接失败（brief 的接线清单漏了这一行）。
    TelemetryService,
    StudySessionsRepository,
    SubjectsRepository,
    ControlsRepository,
    StudySessionsService,
    AnalyticsInterceptor,
    { provide: 'SUBJECTS_REPO_FOR_ANALYTICS', useExisting: SubjectsRepository },
  ],
  exports: [TelemetryService, AnalyticsInterceptor, StudySessionsService],
})
export class AnalyticsModule {
  constructor(private telemetry: TelemetryService) {
    setLlmCallSink((entry) => this.telemetry.llmCalls.push(entry));
  }
}
