import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/** 兑换相关的家长控制项。只取这两个字段，避免把整张 controls 表带进服务层。 */
export interface ControlsSnapshot {
  /** 多少积分换 1 元。DB 默认 20，家长可配。 */
  pointsPerYuan: number;
  /** 兑换总开关；`false` → 兑换端点直接 400（code 3004）。 */
  rewardRedemptionEnabled: boolean;
}

/** 家长可改的控制项（缺省 = 不动该列）。范围校验在 API 层（Zod），这里只做白名单拼 SQL。 */
export interface ControlsPatch {
  pointsPerYuan?: number;
  rewardRedemptionEnabled?: boolean;
}

/**
 * 家长控制项（`controls`）。本任务只用到兑换两项：`points_per_yuan` / `reward_redemption_enabled`。
 *
 * 全仓此前没有任何 `controls` 代码（`ai.service.ts:153` 还留着 TODO），本 repo 是第一个使用者，
 * 因此**只实现兑换需要的两个方法**，不做「通用 controls 仓储」的过度设计；其余列等有需求再加。
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
   * 读兑换控制项。**无行时返回默认值**（20 分/元、开启），不返回 null、不抛错：
   *
   * - 调用方（兑换服务）已先 `ensure()`，正常不会走到兜底分支；
   * - 但 `points_per_yuan` 迁移未 apply 的库、或 ensure 与读之间行被删，返回默认值比 500 更合理；
   * - 与 `StudentPointsRepository.find` 对无行返回全 0 的口径一致（快照/配置类读不把「缺失」当异常）。
   */
  async findByStudent(studentId: number): Promise<ControlsSnapshot> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { points_per_yuan: number; reward_redemption_enabled: number })[]
    >(
      `SELECT points_per_yuan, reward_redemption_enabled FROM controls WHERE student_id = ? LIMIT 1`,
      [studentId],
    );
    const row = rows[0];
    return {
      pointsPerYuan: Number(row?.points_per_yuan ?? 20),
      rewardRedemptionEnabled: Number(row?.reward_redemption_enabled ?? 1) === 1,
    };
  }

  /**
   * 部分更新控制项（家长端 `PUT /api/parent/students/:id/points/settings`）。
   *
   * 只拼**白名单列**（`points_per_yuan` / `reward_redemption_enabled`），列名不来自入参，
   * 因此不存在 SQL 注入面。空 patch 是 no-op（调用方是用例的 400 闸门）。
   * 返回是否真的命中该生那一行——调用方必须先 `ensure()`，否则 UPDATE 会静默影响 0 行。
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
    if (sets.length === 0) return 0;

    params.push(studentId);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE controls SET ${sets.join(', ')} WHERE student_id = ?`,
      params,
    );
    return result.affectedRows;
  }
}
