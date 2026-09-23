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

  /**
   * 该生在某学科下、每个知识点**可抽题数**（一次分组查询，别 79 次单查）。
   *
   * 谓词与 `QuestionsRepository.findRandomByKpAndType` **逐字同源**：
   * `is_active = 1` + `answer <> ''` + 排除该生 `student_hidden_questions`。
   * 不同步就会出现「推荐说有题、开练抽不到」的落差。
   *
   * 返回 `Map<kpId, 数量>`；没有可抽题的 KP **不出现**在 Map 里（调用方 `?? 0`）。
   */
  async countAvailableQuestionsByKp(
    studentId: number,
    subjectId: number,
  ): Promise<Map<number, number>> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { kp_id: number; n: number | string | null })[]
    >(
      `SELECT qkp.knowledge_point_id AS kp_id, COUNT(DISTINCT q.id) AS n
       FROM questions q
       JOIN question_knowledge_points qkp ON qkp.question_id = q.id
       LEFT JOIN student_hidden_questions shq
         ON shq.question_id = q.id AND shq.student_id = ?
       WHERE q.subject_id = ? AND q.is_active = 1
         AND q.answer <> ''
         AND shq.id IS NULL
       GROUP BY qkp.knowledge_point_id`,
      [studentId, subjectId],
    );
    return new Map(rows.map((r) => [Number(r.kp_id), Number(r.n ?? 0)]));
  }
}
