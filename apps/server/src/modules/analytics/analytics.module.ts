import { Module } from '@nestjs/common';
import { LlmCallLogsRepository } from '../../database/repositories/llm-call-logs.repo.js';
import { ApiRequestLogsRepository } from '../../database/repositories/api-request-logs.repo.js';
import { StudySessionsRepository } from '../../database/repositories/study-sessions.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import { BehaviorEventsRepository } from '../../database/repositories/behavior-events.repo.js';
import { SafetyAlertsModule } from '../safety/safety-alerts.module.js';
import { TelemetryService } from './telemetry.service.js';
import { EventsService } from './events.service.js';
import { StudySessionsService } from './study-sessions.service.js';
import { AnalyticsController } from './analytics.controller.js';
import { TrackController } from './track.controller.js';
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
  controllers: [AnalyticsController, TrackController],
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
    // Phase 2 行为事件流：字典与三道锁（tier 由字典决定 / client 白名单 / 隐私守卫）。
    BehaviorEventsRepository,
    EventsService,
    { provide: 'SUBJECTS_REPO_FOR_ANALYTICS', useExisting: SubjectsRepository },
  ],
  exports: [TelemetryService, AnalyticsInterceptor, StudySessionsService, EventsService],
})
export class AnalyticsModule {
  constructor(
    private telemetry: TelemetryService,
    // Phase 2（2026-10-09）：llm_fallback_triggered 的发射口（本模块 providers 自有，直接构造注入）。
    private readonly eventsService: EventsService,
  ) {
    // 回调只在真实 LLM 调用时触发（emitLlmCall），不存在「EventsService 未就绪」的启动顺序问题。
    setLlmCallSink((entry) => {
      this.telemetry.llmCalls.push(entry);
      if (entry.isFallback) {
        // scene 是 LLM 侧自由取值、不在学生场景白名单里 → 走 props 而不是顶层 scene 列。
        this.eventsService.track({
          event: 'llm_fallback_triggered',
          source: 'server',
          studentId: entry.studentId ?? null,
          props: { scene: entry.scene ?? null, toModel: entry.modelKey },
        });
      }
    });
  }
}
