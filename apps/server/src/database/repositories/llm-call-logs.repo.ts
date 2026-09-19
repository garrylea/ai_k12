import { Injectable, Inject } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import type { LlmCallLogEntry } from '../../ai-core/infra/llm-call-log.js';

/** 列顺序即 INSERT 的参数顺序；改列序必须同步改 COLUMNS 常量与测试里的下标断言 */
const COLUMNS = [
  'request_id', 'student_id', 'dialogue_id', 'scene', 'subject', 'capability',
  'model_key', 'model_id', 'provider', 'attempt', 'request_kind', 'is_fallback',
  'success', 'error_type', 'http_status', 'input_tokens', 'output_tokens',
  'usage_source', 'latency_ms',
] as const;

@Injectable()
export class LlmCallLogsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  /**
   * 批量落账本。必须走 pool.query 而非 execute：占位符数量随行数变化，
   * 预处理语句不能这样拼（与 point-ledger.repo 的 LIMIT ? 同一个坑）。
   */
  async insertMany(entries: LlmCallLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const placeholders = entries.map(() => `(${COLUMNS.map(() => '?').join(', ')})`).join(', ');
    const args = entries.flatMap((e) => [
      e.requestId, e.studentId, e.dialogueId, e.scene, e.subject, e.capability,
      e.modelKey, e.modelId, e.provider, e.attempt, e.requestKind, e.isFallback ? 1 : 0,
      e.success ? 1 : 0, e.errorType, e.httpStatus, e.inputTokens, e.outputTokens,
      e.usageSource, e.latencyMs,
    ]);
    await this.pool.query(
      `INSERT INTO llm_call_logs (${COLUMNS.join(', ')}) VALUES ${placeholders}`,
      args,
    );
  }
}
