import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/**
 * question_hints 题级提示缓存 repo（训练模块 Task 3）。
 *
 * 与 practice 的 cards.hints JSON 缓存不同：这里是题中心一张表一行一题
 * （PRIMARY KEY question_id），写回走 ON DUPLICATE KEY UPDATE 幂等 upsert。
 */
@Injectable()
export class QuestionHintsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findByQuestionId(questionId: number): Promise<{ hint: string } | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT hint FROM question_hints WHERE question_id = ?`,
      [questionId],
    );
    return (rows[0] as { hint: string }) ?? null;
  }

  async upsert(questionId: number, hint: string): Promise<void> {
    await this.pool.execute(
      `INSERT INTO question_hints (question_id, hint) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE hint = VALUES(hint), updated_at = CURRENT_TIMESTAMP(3)`,
      [questionId, hint],
    );
  }
}
