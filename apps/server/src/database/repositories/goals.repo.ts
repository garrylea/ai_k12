import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/**
 * 目标维度（与 `goals.metric` 的列注释逐字一致）。
 *
 * ⚠️ 2026-09-20 起**所有指标都按学科**（P6.5）：同一個 metric 会在不同学科各有一行，
 * 所以「metric」不再唯一标识一个目标，`(subjectId, metric)` 才是。
 */
export type GoalMetric =
  | 'daily_study_minutes'
  | 'weekly_lessons'
  | 'daily_words'
  | 'weekly_passages'
  | 'weekly_clear_errors';

export type GoalPeriod = 'daily' | 'weekly';

export interface GoalRow {
  id: number;
  /** 学科；为 NULL 的行是迁移前的历史停用行（读侧被 is_active=1 过滤），调用方应跳过。 */
  subjectId: number | null;
  metric: GoalMetric | null;
  period: string;
  targetValue: number;
  title: string;
}

/**
 * `goals` 的读写（埋点 Phase 1B 复活这张表；2026-09-20 P6.5 改为**按学科**）。
 *
 * 唯一键是 `(student_id, scope_subject_id, metric)`，其中 `scope_subject_id` 是**生成列**
 * （`IF(metric IS NULL, NULL, COALESCE(subject_id, 0))`，VIRTUAL）。为什么要生成列：
 * MySQL 的唯一索引把 NULL 视为互不相等，直接用 `(student_id, subject_id, metric)` 会让
 * `subject_id IS NULL` 的行失去唯一性、`ON DUPLICATE KEY` 静默失效（详见迁移注释）。
 */
@Injectable()
export class GoalsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 该学生所有**启用中**的目标。
   *
   * `ORDER BY subject_id, id`：学科升序（与 `ProgressRepository.findSubjectIdsByStudent`
   * 同序），service 会再按「学科 sort_order → 指标模板顺序」重排；这里给个确定性兜底顺序。
   */
  async findActiveByStudent(studentId: number): Promise<GoalRow[]> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        id: number;
        subject_id: number | null;
        metric: GoalMetric | null;
        period: string;
        target_value: number | string | null;
        title: string;
      })[]
    >(
      `SELECT id, subject_id, metric, period, target_value, title
       FROM goals
       WHERE student_id = ? AND is_active = 1
       ORDER BY subject_id, id`,
      [studentId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      subjectId: r.subject_id === null ? null : Number(r.subject_id),
      metric: r.metric,
      period: r.period,
      targetValue: Number(r.target_value ?? 0),
      title: r.title,
    }));
  }

  /**
   * **只补缺失的**默认目标（按学科：每个 `(学科, 指标)` 一行）。
   *
   * ⚠️ 必须 `INSERT IGNORE`：唯一键命中时若用 `ON DUPLICATE KEY UPDATE`，家长已改过的
   * 目标会被默认值**覆盖回去**。IGNORE 遇到已存在就跳过，正是懒初始化要的语义。
   *
   * ⚠️ **占位符顺序必须与列清单逐位对应**（`student_id, subject_id, metric, title, period, target_value`）：
   * 2026-09-22 端到端冒烟实测栽过——参数写成 `[studentId, metric, period, title, target]` 时
   * `title` 与 `period` 会对调，库里落下 `title='daily' / period='每日学习时长'`。
   * **单测只断言 params 字面量也拦不住**（那只证明代码与它自己一致）——本文件的测试用
   * `zipInsert()` 按列名配对断言；改这里也必须用真库验证一次。
   */
  async ensureDefaults(
    studentId: number,
    defaults: ReadonlyArray<{
      subjectId: number;
      metric: GoalMetric;
      period: GoalPeriod;
      title: string;
      target: number;
    }>,
  ): Promise<void> {
    for (const d of defaults) {
      await this.pool.execute(
        `INSERT IGNORE INTO goals
           (student_id, subject_id, metric, title, period, target_value, reminder_enabled, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1)`,
        [studentId, d.subjectId, d.metric, d.title, d.period, d.target],
      );
    }
  }

  /**
   * 家长显式保存某个 `(学科, 指标)` 的目标值（PUT 路径）。
   *
   * 用 `ON DUPLICATE KEY UPDATE`（与 `ensureDefaults` 相反，这里**就是**要覆盖），
   * 并把 `is_active` 置回 1——家长重新启用一个曾被停用的目标时不该另插一行。
   * 占位符顺序同上（`subject_id` 紧跟 `student_id`，`title` 在 `period` 之前）。
   *
   * `reminder_enabled` 恒 0：提醒本期不做（2026-09-20 用户裁决，见 PRD/UX 批注）。
   */
  async upsertTarget(
    studentId: number,
    subjectId: number,
    metric: GoalMetric,
    period: GoalPeriod,
    title: string,
    target: number,
  ): Promise<void> {
    await this.pool.execute(
      `INSERT INTO goals
         (student_id, subject_id, metric, title, period, target_value, reminder_enabled, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1) AS new
       ON DUPLICATE KEY UPDATE
         target_value = new.target_value,
         period       = new.period,
         title        = new.title,
         subject_id   = new.subject_id,
         is_active    = 1`,
      [studentId, subjectId, metric, title, period, target],
    );
  }
}
