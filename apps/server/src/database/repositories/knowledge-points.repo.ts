import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface KnowledgePointRow extends RowDataPacket {
  id: number;
  name: string;
  subject_id: number;
  parent_kp_id: number | null;
  grade_band: string;
}

/**
 * knowledge_points 知识点 repo（训练模块 Task 8 专项练习）。
 *
 * findBySubject 返回平铺列表（id/name/parentKpId/gradeBand），树形组装放前端。
 */
@Injectable()
export class KnowledgePointsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findBySubject(
    subjectId: number,
  ): Promise<Array<{ id: number; name: string; parentKpId: number | null; gradeBand: string }>> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, name, parent_kp_id AS parentKpId, grade_band AS gradeBand
       FROM knowledge_points WHERE subject_id = ? ORDER BY id`,
      [subjectId],
    );
    return rows as Array<{ id: number; name: string; parentKpId: number | null; gradeBand: string }>;
  }

  /** 单个知识点（补偿套题 AI 生成需要考点名，2026-09-21）。 */
  async findById(id: number): Promise<KnowledgePointRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM knowledge_points WHERE id = ?`,
      [id],
    );
    return (rows[0] as KnowledgePointRow) ?? null;
  }
}
