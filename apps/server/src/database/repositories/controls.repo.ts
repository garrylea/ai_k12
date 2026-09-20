import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/** 家长控制项的只读快照（兑换 + 预警灵敏度）。按需逐列取，避免把整张 controls 表带进服务层。 */
export interface ControlsSnapshot {
  /** 多少积分换 1 元。DB 默认 20，家长可配。 */
  pointsPerYuan: number;
  /** 兑换总开关；`false` → 兑换端点直接 400（code 3004）。 */
  rewardRedemptionEnabled: boolean;
  /** 切走（隐藏标签页）累计多少分钟写 `away` 预警。DB 默认 5，家长可调 1..180。 */
  alertAwayMinutes: number;
  /** 前台无操作多少分钟写 `idle` 预警。DB 默认 15，家长可调 1..180。 */
  alertIdleMinutes: number;
}

/** 家长可改的控制项（缺省 = 不动该列）。范围校验在 API 层（Zod），这里只做白名单拼 SQL。 */
export interface ControlsPatch {
  pointsPerYuan?: number;
  rewardRedemptionEnabled?: boolean;
  alertAwayMinutes?: number;
  alertIdleMinutes?: number;
}

/**
 * 家长控制项（`controls`）。用到两组共四列：兑换（`points_per_yuan` / `reward_redemption_enabled`）
 * 与预警灵敏度（`alert_away_minutes` / `alert_idle_minutes`）。
 *
 * 全仓此前没有任何 `controls` 代码（`ai.service.ts:153` 还留着 TODO），本 repo 是第一个使用者，
 * 因此**只实现当前有调用方的读法**，不做「通用 controls 仓储」的过度设计；其余列等有需求再加。
 *
 * 该表 `UNIQUE (student_id)`，行应由建学生时创建，但历史存量学生可能没有行——所以读之前
 * 一律先 `ensure()`。
 */
@Injectable()
export class ControlsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 确保该生有 controls 行（幂等）。没有就插默认行，有就完全不动。
   *
   * `ON DUPLICATE KEY UPDATE student_id = student_id` 是等价的 no-op：MySQL 需要 UPDATE 子句
   * 语法才能触发「撞唯一键不报错」的语义，而这里刻意不更新任何业务列——家长改过的开关/汇率
   * 绝不能被一次读操作重置。`id = LAST_INSERT_ID(id)` 那套是为了拿既有 id，本方法不需要。
   */
  async ensure(studentId: number): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO controls (student_id) VALUES (?)
       ON DUPLICATE KEY UPDATE student_id = student_id`,
      [studentId],
    );
  }

  /**
   * 读家长控制项快照。**无行 / 列为 NULL 时返回默认值**（20 分/元、开启、切走 5 分、无操作 15 分），
   * 不返回 null、不抛错：
   *
   * - 调用方（兑换服务 / 管控端点）已先 `ensure()`，正常不会走到兜底分支；
   * - 但迁移未 apply 的库、或 ensure 与读之间行被删，返回默认值比 500 更合理；
   * - 与 `StudentPointsRepository.find` 对无行返回全 0 的口径一致（快照/配置类读不把「缺失」当异常）。
   *
   * 心跳路径**不要**用这个方法：它每 30 秒调一次，只需两个阈值 → 用 `findAlertThresholds`。
   */
  async findByStudent(studentId: number): Promise<ControlsSnapshot> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        points_per_yuan: number;
        reward_redemption_enabled: number;
        alert_away_minutes: number;
        alert_idle_minutes: number;
      })[]
    >(
      `SELECT points_per_yuan, reward_redemption_enabled, alert_away_minutes, alert_idle_minutes
       FROM controls WHERE student_id = ? LIMIT 1`,
      [studentId],
    );
    const row = rows[0];
    return {
      pointsPerYuan: Number(row?.points_per_yuan ?? 20),
      rewardRedemptionEnabled: Number(row?.reward_redemption_enabled ?? 1) === 1,
      alertAwayMinutes: Number(row?.alert_away_minutes ?? 5),
      alertIdleMinutes: Number(row?.alert_idle_minutes ?? 15),
    };
  }

  /**
   * 读预警灵敏度的两个阈值（分钟）：切走多久写 `away`、无操作多久写 `idle`。
   *
   * **单独一条轻量 SELECT、只取两列**，不复用 `findByStudent`：本方法跑在心跳路径上
   * （每 30 秒一次），把兑换汇率/开关一起读出来纯属浪费。和 `findDailyTimeLimit` 同一个形态。
   *
   * **无行 / 列为 NULL → 返回默认档（5 / 15），不返回 null**：`controls` 行由建学生时或
   * `ensure()` 保证存在，仓储不该让心跳调用方处理「没有配置」这种态（两列本就是
   * `NOT NULL DEFAULT`，兜底只为异常态兜底）。
   */
  async findAlertThresholds(
    studentId: number,
  ): Promise<{ awayMinutes: number; idleMinutes: number }> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { alert_away_minutes: number; alert_idle_minutes: number })[]
    >(
      `SELECT alert_away_minutes, alert_idle_minutes FROM controls WHERE student_id = ? LIMIT 1`,
      [studentId],
    );
    const row = rows[0];
    return {
      awayMinutes: Number(row?.alert_away_minutes ?? 5),
      idleMinutes: Number(row?.alert_idle_minutes ?? 15),
    };
  }

  /**
   * 读每日学习时长上限（分钟）。**无行 / 列为 NULL → 返回 null**（= 未设限）。
   *
   * 不复用 `findByStudent`：那个方法刻意只 select 兑换两列，把整张表带进服务层是
   * 它注释里明确拒绝的过度设计。这里同样只取**一个列**，不做通用 controls 仓储。
   *
   * 语义提醒：这个值只是**上限**。它是「行为管控」的一半，另一半「今日已用」
   * 来自 `study_sessions`（Phase 1A 才补上）。**读侧已接好、写侧尚未实现**：
   * `controls.daily_time_limit_minutes` 全仓**没有任何写入方**（`update()` 只白名单
   * 两个积分列，家长端管控页仍是占位），因此目前它**恒为 NULL**、`limitMinutes` 恒为 null。
   */
  async findDailyTimeLimit(studentId: number): Promise<number | null> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { daily_time_limit_minutes: number | null })[]
    >(
      `SELECT daily_time_limit_minutes FROM controls WHERE student_id = ? LIMIT 1`,
      [studentId],
    );
    const value = rows[0]?.daily_time_limit_minutes;
    return value === null || value === undefined ? null : Number(value);
  }

  /**
   * 部分更新控制项（兑换设置 `PUT .../points/settings`、预警灵敏度 `PUT .../controls`）。
   *
   * 只拼**白名单列**（`points_per_yuan` / `reward_redemption_enabled` / `alert_away_minutes` /
   * `alert_idle_minutes`），列名不来自入参，因此不存在 SQL 注入面。空 patch 是 no-op
   * （调用方是用例的 400/409 闸门）。返回是否真的命中该生那一行——调用方必须先 `ensure()`，
   * 否则 UPDATE 会静默影响 0 行。
   */
  async update(studentId: number, patch: ControlsPatch): Promise<number> {
    const sets: string[] = [];
    const params: Array<number | string> = [];
    if (patch.pointsPerYuan !== undefined) {
      sets.push('points_per_yuan = ?');
      params.push(patch.pointsPerYuan);
    }
    if (patch.rewardRedemptionEnabled !== undefined) {
      sets.push('reward_redemption_enabled = ?');
      params.push(patch.rewardRedemptionEnabled ? 1 : 0);
    }
    if (patch.alertAwayMinutes !== undefined) {
      sets.push('alert_away_minutes = ?');
      params.push(patch.alertAwayMinutes);
    }
    if (patch.alertIdleMinutes !== undefined) {
      sets.push('alert_idle_minutes = ?');
      params.push(patch.alertIdleMinutes);
    }
    if (sets.length === 0) return 0;

    params.push(studentId);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE controls SET ${sets.join(', ')} WHERE student_id = ?`,
      params,
    );
    return result.affectedRows;
  }
}
