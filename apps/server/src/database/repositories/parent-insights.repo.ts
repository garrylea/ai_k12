import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/**
 * 家长端只读聚合仓储（spec `2026-09-18-parent-insights-design.md`）。
 *
 * 三条铁律（勿违背）：
 * 1. **只读**：本文件不出现 INSERT / UPDATE / DELETE。
 * 2. **既有的共享仓储一行不动**（如 `main-error-books.repo.ts` 正被训练轨调用），
 *    需要类似查询就在这里照抄写法自建。
 * 3. 带 `LIMIT ?` 的查询必须用 `pool.query`（客户端转义）：MySQL 对预处理语句的
 *    `LIMIT ?` 报 "Incorrect arguments to mysqld_stmt_execute"（见 point-ledger.repo.ts:148 的既有注释）。
 *    其余用 `execute`。
 *
 * 返回一律是**扁平行**，嵌套 DTO 由各 service 组装（与 `point-ledger.repo.ts` 同约定）。
 */
@Injectable()
export class ParentInsightsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 该学生已开始（存在 progress 行）的学科 id，升序。仪表盘只为这些学科出卡片。 */
  async listTrackedSubjectIds(studentId: number): Promise<number[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT DISTINCT subject_id FROM progress WHERE student_id = ? ORDER BY subject_id`,
      [studentId],
    );
    return rows.map((r) => Number(r.subject_id));
  }

  /**
   * 活跃度（「学习时长」的代理指标，spec §2.2）。
   *
   * 「活跃」= 下列四张表任一在该时刻有记录。四条并集路径的理由：`point_ledger` 是唯一在
   * **所有**轨道任务完成时都写一行的表（含语文/英语专项），光靠它 + `practice_results` +
   * `exam_sessions` 会漏掉纯答疑活跃，故补 `ai_messages`。
   *
   * `lastActiveAt` 是**全时段** MAX、`activeDays` 只数 `windowStart` 之后——两者窗口不同，
   * 必须分两次查，合并成一个 SQL 会算错。
   */
  async getActivitySummary(
    studentId: number,
    windowStart: Date,
  ): Promise<{ lastActiveAt: Date | null; activeDays: number }> {
    const [maxRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT MAX(ts) AS last_active_at FROM (
         SELECT judged_at AS ts FROM practice_results WHERE student_id = ?
         UNION ALL SELECT created_at AS ts FROM point_ledger WHERE student_id = ?
         UNION ALL SELECT submitted_at AS ts FROM exam_sessions
                   WHERE student_id = ? AND submitted_at IS NOT NULL
         UNION ALL SELECT m.created_at AS ts FROM ai_messages m
                   JOIN ai_dialogues d ON d.id = m.dialogue_id
                   WHERE d.student_id = ? AND m.deleted_at IS NULL
       ) t`,
      [studentId, studentId, studentId, studentId],
    );

    const [dayRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT DATE(ts)) AS active_days FROM (
         SELECT judged_at AS ts FROM practice_results WHERE student_id = ? AND judged_at >= ?
         UNION ALL SELECT created_at AS ts FROM point_ledger WHERE student_id = ? AND created_at >= ?
         UNION ALL SELECT submitted_at AS ts FROM exam_sessions
                   WHERE student_id = ? AND submitted_at IS NOT NULL AND submitted_at >= ?
         UNION ALL SELECT m.created_at AS ts FROM ai_messages m
                   JOIN ai_dialogues d ON d.id = m.dialogue_id
                   WHERE d.student_id = ? AND m.deleted_at IS NULL AND m.created_at >= ?
       ) t`,
      [studentId, windowStart, studentId, windowStart, studentId, windowStart, studentId, windowStart],
    );

    const raw = maxRows[0]?.last_active_at;
    return {
      lastActiveAt: raw ? new Date(raw as string | Date) : null,
      activeDays: Number(dayRows[0]?.active_days ?? 0),
    };
  }
}
