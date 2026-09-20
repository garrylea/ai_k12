import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/**
 * 课时完成事件（P6.5「每周完课目标」的唯一数据源）。
 *
 * ⚠️ **历史完课补不回来**：本表上线（2026-09-20）前学完的课时没有记录，达成值从上线起算 ——
 * 页面文案要说清，否则家长会以为孩子少学了。此前 `progress` 表只有游标
 * （`current_lesson_id`，覆盖式更新、无历史），回答不了「本周完成了几课」。
 *
 * `lesson_id` **无外键**：`lessons` 是内容表、会全量重灌，设入向外键会把重灌卡死
 * （同 `special_practice_logs.ref_id`、`student_word_progress.word_id` 的教训）。
 */
@Injectable()
export class LessonCompletionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 记一次完课。**`INSERT IGNORE`**：唯一键 `(student_id, lesson_id)` 让「同一课重复完成」
   * 静默跳过（完成不可逆，重复上报/重放都不是错误）。返回自增 id，调用方只用于日志。
   */
  async recordCompletion(input: {
    studentId: number;
    subjectId: number;
    lessonId: number;
  }): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO lesson_completions (student_id, subject_id, lesson_id)
       VALUES (?, ?, ?)`,
      [input.studentId, input.subjectId, input.lessonId],
    );
    return result.insertId ?? 0;
  }

  /**
   * 窗口内某学科完成的课时数。
   * 半开区间 `< endExclusive`；**窗口由应用层算好传参**（不用 `CURDATE()`——DB 会话时区
   * 与 Node 可能不一致，会算错一天）。
   */
  async countInWindow(
    studentId: number,
    subjectId: number,
    from: Date,
    toExclusive: Date,
  ): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { n: number | string | null })[]>(
      `SELECT COUNT(*) AS n
       FROM lesson_completions
       WHERE student_id = ? AND subject_id = ?
         AND completed_at >= ? AND completed_at < ?`,
      [studentId, subjectId, from, toExclusive],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
