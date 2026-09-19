import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LlmCallLogsRepository } from '../../database/repositories/llm-call-logs.repo.js';
import { ApiRequestLogsRepository } from '../../database/repositories/api-request-logs.repo.js';
import { TelemetryBuffer } from './telemetry-buffer.js';
import type { LlmCallLogEntry } from '../../ai-core/infra/llm-call-log.js';
import type { ApiRequestLogEntry } from '../../database/repositories/api-request-logs.repo.js';

/**
 * 两个埋点 buffer 的持有者。buffer 的 flush 直接调 repo 的批量插入；
 * 失败由 TelemetryBuffer 吞掉（整批丢弃、不重试），因此这里不做 try/catch。
 */
@Injectable()
export class TelemetryService implements OnModuleInit, OnModuleDestroy {
  readonly llmCalls: TelemetryBuffer<LlmCallLogEntry>;
  readonly apiRequests: TelemetryBuffer<ApiRequestLogEntry>;

  constructor(
    llmCallLogsRepo: LlmCallLogsRepository,
    apiRequestLogsRepo: ApiRequestLogsRepository,
  ) {
    this.llmCalls = new TelemetryBuffer<LlmCallLogEntry>(
      (rows) => llmCallLogsRepo.insertMany(rows),
      { name: 'llm_call_logs' },
    );
    this.apiRequests = new TelemetryBuffer<ApiRequestLogEntry>(
      (rows) => apiRequestLogsRepo.insertMany(rows),
      { name: 'api_request_logs' },
    );
  }

  onModuleInit(): void {
    this.llmCalls.start();
    this.apiRequests.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.llmCalls.stop();
    this.apiRequests.stop();
    // 退出前兜最后一次落库（仍可能丢不足一个 flush 间隔的数据，可接受）
    await this.llmCalls.flushNow();
    await this.apiRequests.flushNow();
  }
}
