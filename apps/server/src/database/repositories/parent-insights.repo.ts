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

  /**
   * 该学生已开始学习的学科 id，升序去重。仪表盘只为这些学科出卡片。
   *
   * 判定用 `status <> 'not_started'`，**不能**用「存在 progress 行」——行存在 ≠ 已开始：
   * 家长在「学习配置」里配教材会走 `ProgressRepository.createConfig`
   * （progress.repo.ts:62-75，写入 status='not_started'、current_lesson_id=NULL），
   * `applyConfig(reset=true)`（progress.repo.ts:83-92）也会把已有行重置回 not_started。
   * 若只看行存在，这两个场景会给「只配过教材、根本没开始学」的学科渲染卡片。
   *
   * 也不用 `started_at IS NOT NULL`：`ProgressRepository.create`（progress.repo.ts:44-59）
   * 是学生首次学习时的自动初始化（status='in_progress'、current_lesson_id 已设），
   * 但它**不写 started_at**（该列为 NULL 默认值），用它会把真正已开始的学科漏掉。
   * status 是唯一在所有写入路径下都可靠的谓词（create/adoptLesson→in_progress，
   * createConfig/applyConfig reset→not_started，markCompleted→completed）。
   */
  async listTrackedSubjectIds(studentId: number): Promise<number[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT DISTINCT subject_id FROM progress
       WHERE student_id = ? AND status <> 'not_started'
       ORDER BY subject_id`,
      [studentId],
    );
    return rows.map((r) => Number(r.subject_id));
  }

  /**
   * 四路活跃来源的**唯一构造器**。`lastActiveAt`（全时段）与 `activeDays`（窗口内）
   * 共用它，增删活跃来源只改这一处，避免两个指标口径分叉。
   *
   * `windowStart` 省略 = 全时段（不加时间下界）；给出 = 每条支路追加 `<ts> >= ?`。
   * 参数按支路顺序追加：每支先 studentId，有窗口再追加 windowStart。
   */
  private buildActivitySources(
    studentId: number,
    windowStart?: Date,
  ): { sql: string; params: (number | Date)[] } {
    const params: (number | Date)[] = [];
    /** 拼一条支路的 WHERE：始终带 studentId；有窗口时追加该支路自己的时间列下界。 */
    const where = (base: string, tsColumn: string): string => {
      params.push(studentId);
      if (windowStart == null) return base;
      params.push(windowStart);
      return `${base} AND ${tsColumn} >= ?`;
    };

    const sql = [
      `SELECT judged_at AS ts FROM practice_results WHERE ${where('student_id = ?', 'judged_at')}`,
      `UNION ALL SELECT created_at AS ts FROM point_ledger WHERE ${where('student_id = ?', 'created_at')}`,
      `UNION ALL SELECT submitted_at AS ts FROM exam_sessions WHERE ${where(
        'student_id = ? AND submitted_at IS NOT NULL',
        'submitted_at',
      )}`,
      `UNION ALL SELECT m.created_at AS ts FROM ai_messages m
         JOIN ai_dialogues d ON d.id = m.dialogue_id
         WHERE ${where('d.student_id = ? AND m.deleted_at IS NULL', 'm.created_at')}`,
    ].join('\n');

    return { sql, params };
  }

  /**
   * 活跃度（「学习时长」的代理指标，spec §2.2）。
   *
   * 「活跃」= 下列四张表任一在该时刻有记录。四条并集路径的理由：`point_ledger` 是唯一在
   * **所有**轨道任务完成时都写一行的表（含语文/英语专项），光靠它 + `practice_results` +
   * `exam_sessions` 会漏掉纯答疑活跃，故补 `ai_messages`。
   *
   * `lastActiveAt` 是**全时段** MAX、`activeDays` 只数 `windowStart` 之后——两者窗口不同，
   * 必须分两次查，合并成一个 SQL 会算错。两次查共用 `buildActivitySources`。
   */
  async getActivitySummary(
    studentId: number,
    windowStart: Date,
  ): Promise<{ lastActiveAt: Date | null; activeDays: number }> {
    const allTime = this.buildActivitySources(studentId);
    const [maxRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT MAX(ts) AS last_active_at FROM (
${allTime.sql}
) t`,
      allTime.params,
    );

    const windowed = this.buildActivitySources(studentId, windowStart);
    const [dayRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT DATE(ts)) AS active_days FROM (
${windowed.sql}
) t`,
      windowed.params,
    );

    const raw = maxRows[0]?.last_active_at;
    return {
      lastActiveAt: raw ? new Date(raw as string | Date) : null,
      activeDays: Number(dayRows[0]?.active_days ?? 0),
    };
  }
}
