import { Injectable, Inject } from '@nestjs/common';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface RewardCatalogRow extends RowDataPacket {
  id: number;
  student_id: number;
  name: string;
  description: string | null;
  points_cost: number;
  min_level_code: string | null;
  is_active: number;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * 可写字段的**完整**集合。`saveCatalog` 是整表 PUT（parent 端永远是「把当前清单整体存回去」），
 * 每条都按完整行落库，不做部分更新——因此没有 patch 语义，`update` 会覆盖这六列。
 */
export interface RewardCatalogWriteInput {
  name: string;
  description: string | null;
  pointsCost: number;
  minLevelCode: string | null;
  isActive: boolean;
  sortOrder: number;
}

/**
 * 家长配的奖励清单（`reward_catalog`）。无外键指向内容表，只挂 `students(id)`。
 *
 * **软删**：批量保存时「不在 payload 里的 id」置 `is_active = 0`，**不物理删**——兑换单里的
 * `reward_name` 已是快照，但保留行便于对账/将来恢复。学生端只读 active 的（见 service）。
 *
 * `listByStudent` 返回**全部**行（含已下架），供家长配置页看到并重新启用——与
 * `PointRulesRepository.findByStudent` 回传 `is_active=0` 档位的既有约定一致。
 */
@Injectable()
export class RewardCatalogRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async listByStudent(studentId: number): Promise<RewardCatalogRow[]> {
    const [rows] = await this.pool.execute<RewardCatalogRow[]>(
      `SELECT * FROM reward_catalog WHERE student_id = ? ORDER BY sort_order, id`,
      [studentId],
    );
    return rows;
  }

  /** 归属校验内建在 WHERE 里：别人的 catalogId 查不到，调用方按 1002 处理。 */
  async findOne(studentId: number, id: number): Promise<RewardCatalogRow | null> {
    const [rows] = await this.pool.execute<RewardCatalogRow[]>(
      `SELECT * FROM reward_catalog WHERE student_id = ? AND id = ? LIMIT 1`,
      [studentId, id],
    );
    return rows[0] ?? null;
  }

  async insert(
    studentId: number,
    input: RewardCatalogWriteInput,
    conn?: PoolConnection,
  ): Promise<number> {
    const [result] = await (conn ?? this.pool).execute<ResultSetHeader>(
      `INSERT INTO reward_catalog
         (student_id, name, description, points_cost, min_level_code, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        studentId,
        input.name,
        input.description,
        input.pointsCost,
        input.minLevelCode,
        input.isActive ? 1 : 0,
        input.sortOrder,
      ],
    );
    return result.insertId;
  }

  /**
   * 全列覆盖并返回 `affectedRows`；`0` 即「该 id 不存在或不属于该生」。
   *
   * 只看匹配行数即可（mysql2 默认带 `FOUND_ROWS`，原样重存同样的值仍返回 1），
   * 与 `PointRulesRepository.updateOne` 同一口径。
   *
   * @param conn 可选：`saveCatalog` 的批量保存必须传自己的事务连接，整批原子。
   */
  async update(
    studentId: number,
    id: number,
    input: RewardCatalogWriteInput,
    conn?: PoolConnection,
  ): Promise<number> {
    const [result] = await (conn ?? this.pool).execute<ResultSetHeader>(
      `UPDATE reward_catalog
          SET name = ?, description = ?, points_cost = ?, min_level_code = ?, is_active = ?, sort_order = ?
        WHERE student_id = ? AND id = ?`,
      [
        input.name,
        input.description,
        input.pointsCost,
        input.minLevelCode,
        input.isActive ? 1 : 0,
        input.sortOrder,
        studentId,
        id,
      ],
    );
    return result.affectedRows;
  }

  /**
   * 软删：把该生「不在 `keepIds` 里且当前 active」的行置 `is_active = 0`。
   *
   * 空数组要单独走一条 SQL——`NOT IN ()` 是语法错误。空数组的语义是「payload 里一条都没有 →
   * 全部下架」，所以走 `AND is_active = 1` 的全量下架分支。
   *
   * @param conn 可选：必须与 insert/update 同事务，否则「读到一半的清单」会留下错误的下架结果。
   */
  async deactivateMissing(
    studentId: number,
    keepIds: number[],
    conn?: PoolConnection,
  ): Promise<void> {
    const runner = conn ?? this.pool;
    if (keepIds.length === 0) {
      await runner.execute(
        `UPDATE reward_catalog SET is_active = 0 WHERE student_id = ? AND is_active = 1`,
        [studentId],
      );
      return;
    }
    const placeholders = keepIds.map(() => '?').join(', ');
    await runner.execute(
      `UPDATE reward_catalog
          SET is_active = 0
        WHERE student_id = ? AND is_active = 1 AND id NOT IN (${placeholders})`,
      [studentId, ...keepIds],
    );
  }
}
