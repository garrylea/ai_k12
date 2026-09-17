import { Injectable, Inject } from '@nestjs/common';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { DefaultRule } from '../../modules/points/default-rules.js';

export interface PointRuleRow extends RowDataPacket {
  id: number;
  student_id: number;
  task_code: string;
  tier_key: string;
  tier_label: string;
  points: number;
  daily_limit: number | null;
  sort_order: number;
  is_active: number;
  created_at: Date;
  updated_at: Date;
}

/** 家长端改档位只动这三个字段；未提供的字段不进 SET 子句。 */
export interface UpdatePointRuleInput {
  points?: number;
  dailyLimit?: number | null;
  isActive?: boolean;
}

/**
 * 家长可配的分值表（`point_rules`）。
 *
 * 一张表靠 `tier_key` 装三种档位维度（词数 / 题数 / 体裁 / 'default'），语义由 `task_code` 决定。
 * 初始化策略是**懒初始化 + 幂等补齐**：任何读写该学生规则的入口先 `insertIgnoreBatch` 补默认档位，
 * 新增任务/档位因此零迁移。代价是改代码里的默认值不回溯已初始化的学生——有意接受（家长本就要自己调）。
 */
@Injectable()
export class PointRulesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findByStudent(studentId: number): Promise<PointRuleRow[]> {
    const [rows] = await this.pool.execute<PointRuleRow[]>(
      `SELECT * FROM point_rules WHERE student_id = ? ORDER BY sort_order, id`,
      [studentId],
    );
    return rows;
  }

  /**
   * 懒初始化核心：一条**多行** `INSERT IGNORE` 写入该生的默认档位。
   *
   * 撞 `uniq_point_rules (student_id, task_code, tier_key)` 的行被 MySQL 静默跳过，
   * 因此家长已改过的值不会被默认值覆盖。调用方（PointRulesService.ensureRules）只传缺失的档位，
   * 这里再兜一层空数组短路，避免生成 `VALUES` 为空的非法 SQL。
   *
   * @param conn 可选：调用方在事务里跑时传入自己的连接（如家长批量保存）。
   */
  async insertIgnoreBatch(
    studentId: number,
    rules: DefaultRule[],
    conn?: PoolConnection,
  ): Promise<void> {
    if (rules.length === 0) return;
    const placeholders = rules.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = rules.flatMap((r) => [
      studentId,
      r.taskCode,
      r.tierKey,
      r.tierLabel,
      r.points,
      r.dailyLimit,
      r.sortOrder,
    ]);
    const sql = `INSERT IGNORE INTO point_rules
       (student_id, task_code, tier_key, tier_label, points, daily_limit, sort_order)
       VALUES ${placeholders}`;
    if (conn) {
      await conn.execute(sql, params);
      return;
    }
    await this.pool.execute(sql, params);
  }

  /**
   * 家长改单个档位，返回 `affectedRows`；`0` 即「该 (task_code, tier_key) 不存在」。
   *
   * 这里能只看匹配行数、不受「值没变」影响：mysql2 默认带 `FOUND_ROWS` 标志，
   * 因此 UPDATE 的 affectedRows 是**匹配行数**而非改动行数（`changedRows` 才是后者）。
   * 家长提交与库里完全相同的值，行存在时仍返回 1。
   *
   * @param conn 可选：家长批量保存必须传自己的事务连接，让「逐条 UPDATE + 失败回滚」原子生效
   *   （不传则每条 UPDATE 各自独立提交，回滚撤不回来）。
   */
  async updateOne(
    studentId: number,
    taskCode: string,
    tierKey: string,
    patch: UpdatePointRuleInput,
    conn?: PoolConnection,
  ): Promise<number> {
    const sets: string[] = [];
    const params: Array<number | string | null> = [];
    if (patch.points !== undefined) {
      sets.push('points = ?');
      params.push(patch.points);
    }
    if (patch.dailyLimit !== undefined) {
      sets.push('daily_limit = ?');
      params.push(patch.dailyLimit);
    }
    if (patch.isActive !== undefined) {
      sets.push('is_active = ?');
      params.push(patch.isActive ? 1 : 0);
    }
    if (sets.length === 0) return 0;
    params.push(studentId, taskCode, tierKey);
    const [result] = await (conn ?? this.pool).execute<ResultSetHeader>(
      `UPDATE point_rules SET ${sets.join(', ')}
       WHERE student_id = ? AND task_code = ? AND tier_key = ?`,
      params,
    );
    return result.affectedRows;
  }

  async findOne(
    studentId: number,
    taskCode: string,
    tierKey: string,
  ): Promise<PointRuleRow | null> {
    const [rows] = await this.pool.execute<PointRuleRow[]>(
      `SELECT * FROM point_rules
       WHERE student_id = ? AND task_code = ? AND tier_key = ?
       LIMIT 1`,
      [studentId, taskCode, tierKey],
    );
    return rows[0] ?? null;
  }
}
