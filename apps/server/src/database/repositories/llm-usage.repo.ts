import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface LlmUsageDayRow extends RowDataPacket {
  day: string;
  calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  tokens_unknown: number;
}

/**
 * LLM 用量聚合（`llm_call_logs`，只读）。列名以 schema.sql 实际为准：
 * `student_id`（可空，ON DELETE SET NULL）/ `created_at` / `input_tokens` /
 * `output_tokens`——与批② 计划里的写法一致，非占位。
 *
 * JOIN students 即聚合范围 = 该家长名下所有学生；student_id 为 NULL 的
 * 匿名行（admin-chat/探活）自然被内连接排除。
 */
@Injectable()
export class LlmUsageRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 按日聚合某家长的 LLM 调用量（窗口 [start, end) 由 service 传入）。
   *
   * GROUP BY 聚合查询走 `pool.query` 而非 execute（与 LIMIT ? 同一条仓规：
   * 聚合形态查询不依赖预处理语句，见 learning-sessions.repo.ts:151）。
   *
   * NULL 语义仓规：`input_tokens` / `output_tokens` 可空，**NULL = 量不到，
   * 绝不按 0 混入**——单列 `tokens_unknown` 独立计数；某日 SUM 全 NULL 时
   * 返回 NULL（不是 0），由 service 归零处理、不影响 tokensUnknown。
   * 日列用 DATE_FORMAT 直接回字符串，避免 mysql2 把 DATE() 转成本地时区 Date。
   */
  async aggregateByDay(parentId: number, start: Date, end: Date): Promise<LlmUsageDayRow[]> {
    const [rows] = await this.pool.query<LlmUsageDayRow[]>(
      `SELECT DATE_FORMAT(l.created_at, '%Y-%m-%d') AS day,
              COUNT(*) AS calls,
              SUM(l.input_tokens) AS input_tokens,
              SUM(l.output_tokens) AS output_tokens,
              SUM(l.input_tokens IS NULL OR l.output_tokens IS NULL) AS tokens_unknown
         FROM llm_call_logs l
         JOIN students s ON l.student_id = s.id
        WHERE s.parent_id = ? AND l.created_at >= ? AND l.created_at < ?
        GROUP BY day
        ORDER BY day`,
      [parentId, start, end],
    );
    return rows;
  }
}
