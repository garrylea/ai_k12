import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/** 四个目标维度（与 `goals.metric` 的列注释逐字一致）。 */
export type GoalMetric =
  | 'daily_study_minutes'
  | 'daily_words'
  | 'weekly_passages'
  | 'weekly_clear_errors';

export type GoalPeriod = 'daily' | 'weekly';

export interface GoalRow {
  id: number;
  metric: GoalMetric | null;
  period: string;
  targetValue: number;
  title: string;
}

/**
 * `goals` 的读写（埋点 Phase 1B，复活这张死表）。
 *
 * 唯一键 `(student_id, metric)`（Task 1 加的）让「按 metric upsert」成立。
 * `metric` 为 NULL 的历史行按 `daily_study_minutes` 解释（迁移里已回填）。
 */
@Injectable()
export class GoalsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 该学生所有**启用中**的目标。 */
  async findActiveByStudent(studentId: number): Promise<GoalRow[]> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { id: number; metric: GoalMetric | null; period: string; target_value: number | string | null; title: string })[]
    >(
      `SELECT id, metric, period, target_value, title
       FROM goals
       WHERE student_id = ? AND is_active = 1
       ORDER BY id`,
      [studentId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      metric: r.metric,
      period: r.period,
      targetValue: Number(r.target_value ?? 0),
      title: r.title,
    }));
  }

  /**
   * **只补缺失的**默认目标。
   *
   * ⚠️ 必须 `INSERT IGNORE`：唯一键是 `(student_id, metric)`，若用 `ON DUPLICATE KEY UPDATE`，
   * 家长已改过的目标会被默认值**覆盖回去**。IGNORE 遇到已存在就跳过，正是懒初始化要的语义。
   *
   * ⚠️ **占位符顺序必须与列清单逐位对应**（`student_id, subject_id, metric, title, period, target_value`）：
   * 2026-09-22 端到端冒烟实测栽过——参数写成 `[studentId, metric, period, title, target]` 时
   * `title` 与 `period` 会对调，库里落下 `title='daily' / period='每日学习时长'`。
   * 单测（断言 params 字面量）与接口响应都看不出来：响应里的 title/period 由 `GoalsService`
   * 从常量回填，把库里的脏值盖住了。**改这里必须用真库验证**（或按列名配对断言）。
   */
  async ensureDefaults(
    studentId: number,
    defaults: ReadonlyArray<{ metric: GoalMetric; period: GoalPeriod; title: string; target: number }>,
  ): Promise<void> {
    for (const d of defaults) {
      await this.pool.execute(
        `INSERT IGNORE INTO goals
           (student_id, subject_id, metric, title, period, target_value, reminder_enabled, is_active)
         VALUES (?, NULL, ?, ?, ?, ?, 0, 1)`,
        [studentId, d.metric, d.title, d.period, d.target],
      );
    }
  }

  /**
   * 家长显式保存某个 metric 的目标值（PUT 路径）。
   *
   * 用 `ON DUPLICATE KEY UPDATE`（与 `ensureDefaults` 相反，这里**就是**要覆盖），
   * 并把 `is_active` 置回 1——家长重新启用一个曾被停用的目标时不该另插一行。
   * 占位符顺序同上：`title` 在 `period` 之前（列清单顺序，别按语义直觉排）。
   */
  async upsertTarget(
    studentId: number,
    metric: GoalMetric,
    period: GoalPeriod,
    title: string,
    target: number,
  ): Promise<void> {
    await this.pool.execute(
      `INSERT INTO goals
         (student_id, subject_id, metric, title, period, target_value, reminder_enabled, is_active)
       VALUES (?, NULL, ?, ?, ?, ?, 0, 1) AS new
       ON DUPLICATE KEY UPDATE
         target_value = new.target_value,
         period       = new.period,
         title        = new.title,
         is_active    = 1`,
      [studentId, metric, title, period, target],
    );
  }
}
