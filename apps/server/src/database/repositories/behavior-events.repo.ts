import { Inject } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';

export const BEHAVIOR_EVENT_COLUMNS = [
  'actor_role', 'student_id', 'event', 'tier', 'module', 'scene', 'subject_id',
  'ref_type', 'ref_id', 'session_uid', 'request_id', 'source', 'props', 'client_ts_ms',
] as const;
// 注：created_at 由 DB DEFAULT CURRENT_TIMESTAMP(3) 填，不在 INSERT 列里。

export type BehaviorEventRow = {
  [K in (typeof BEHAVIOR_EVENT_COLUMNS)[number]]: string | number | null;
};

export class BehaviorEventsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async insertMany(rows: BehaviorEventRow[]): Promise<void> {
    if (rows.length === 0) return;
    const placeholders = rows.map(() => `(${BEHAVIOR_EVENT_COLUMNS.map(() => '?').join(',')})`).join(',');
    const params = rows.flatMap((row) => BEHAVIOR_EVENT_COLUMNS.map((col) => row[col] ?? null));
    await this.pool.query(
      `INSERT INTO behavior_events (${BEHAVIOR_EVENT_COLUMNS.join(',')}) VALUES ${placeholders}`,
      params,
    );
  }
}
