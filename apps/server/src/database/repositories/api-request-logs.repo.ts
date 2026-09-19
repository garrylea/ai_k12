import { Injectable, Inject } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';

export interface ApiRequestLogEntry {
  requestId: string | null;
  actorRole: string | null;
  studentId: number | null;
  method: string;
  /** 归一化模板，如 /api/practice/:cardId/judge */
  route: string;
  rawPath: string;
  module: string | null;
  statusCode: number;
  bizCode: number | null;
  errorCode: string | null;
  latencyMs: number;
  isSse: boolean;
}

const COLUMNS = [
  'request_id', 'actor_role', 'student_id', 'method', 'route', 'raw_path',
  'module', 'status_code', 'biz_code', 'error_code', 'latency_ms', 'is_sse',
] as const;

@Injectable()
export class ApiRequestLogsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async insertMany(entries: ApiRequestLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const placeholders = entries.map(() => `(${COLUMNS.map(() => '?').join(', ')})`).join(', ');
    const args = entries.flatMap((e) => [
      e.requestId, e.actorRole, e.studentId, e.method, e.route, e.rawPath,
      e.module, e.statusCode, e.bizCode, e.errorCode, e.latencyMs, e.isSse ? 1 : 0,
    ]);
    await this.pool.query(
      `INSERT INTO api_request_logs (${COLUMNS.join(', ')}) VALUES ${placeholders}`,
      args,
    );
  }
}
