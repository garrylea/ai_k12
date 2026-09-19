import { Module } from '@nestjs/common';
import { LlmCallLogsRepository } from '../../database/repositories/llm-call-logs.repo.js';
import { ApiRequestLogsRepository } from '../../database/repositories/api-request-logs.repo.js';
import { TelemetryService } from './telemetry.service.js';
import { AnalyticsInterceptor } from '../../common/interceptors/analytics.interceptor.js';
import { setLlmCallSink } from '../../ai-core/infra/llm-call-log.js';

/**
 * 埋点模块（Phase 0：只做账本 + 请求日志）。
 *
 * 为什么把 sink 注册放这里：capability 是零参 `new` 出来的、拿不到 DI 容器
 * （见 CLAUDE.md 的 DI 坑），所以 ai-core 用模块级 sink 单例，由本模块在启动时接上。
 */
@Module({
  providers: [LlmCallLogsRepository, ApiRequestLogsRepository, TelemetryService, AnalyticsInterceptor],
  exports: [TelemetryService, AnalyticsInterceptor],
})
export class AnalyticsModule {
  constructor(private telemetry: TelemetryService) {
    setLlmCallSink((entry) => this.telemetry.llmCalls.push(entry));
  }
}
