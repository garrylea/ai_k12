import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface TrainingSessionRow extends RowDataPacket {
  id: number;
  student_id: number;
  task_code: string;
  subject_id: number | null;
  tier_key: string;
  expected_count: number;
  judged_count: number;
  status: 'in_progress' | 'completed' | 'abandoned';
  ref_type: string | null;
  ref_id: number | null;
  started_at: Date;
  completed_at: Date | null;
}

/** 建会话入参用 snake_case（仓内 repo 层统一，对照 `MainErrorBooksRepository.create`）。 */
export interface CreateTrainingSessionInput {
  student_id: number;
  task_code: string;
  subject_id: number | null;
  tier_key: string;
  expected_count: number;
  ref_type: string | null;
  ref_id: number | null;
}

/**
 * 训练会话仓储（`training_sessions`）——**只服务 `math_targeted` / `en_vocabulary`** 两个
 * 「档位打包价」任务。其余 6 类任务在判题函数里有天然发分点，不写这张表。
 *
 * 防伪造的关键：发分按**会话里记录的档位**算，不按前端传来的档位算。`expected_count` /
 * `judged_count` 只做审计留痕，**不阻断发分**（完成即给分）。
 * `status` / `judged_count` 建行时一律走 DB 默认值（`in_progress` / 0），不由应用传。
 */
@Injectable()
export class TrainingSessionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: CreateTrainingSessionInput): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO training_sessions
         (student_id, task_code, subject_id, tier_key, expected_count, ref_type, ref_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.student_id,
        row.task_code,
        row.subject_id,
        row.tier_key,
        row.expected_count,
        row.ref_type,
        row.ref_id,
      ],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<TrainingSessionRow | null> {
    const [rows] = await this.pool.execute<TrainingSessionRow[]>(
      `SELECT * FROM training_sessions WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * 完成会话（幂等）：只对**本人**且 `in_progress` 的会话生效，返回 `affectedRows`。
   * `0` = 已完成过/不是本人/不存在——调用方据此回查首次发分结果，不报错（前端重试要拿到同样返回）。
   */
  async completeOwned(id: number, studentId: number): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE training_sessions
       SET status = 'completed', completed_at = NOW(3)
       WHERE id = ? AND student_id = ?
         AND status = 'in_progress'`,
      [id, studentId],
    );
    return result.affectedRows;
  }

  /**
   * 判题次数 +1（审计留痕）。失败静默由调用方负责——审计不该影响判题。
   * 只累加本人 `in_progress` 的会话。
   */
  async incrementJudged(id: number, studentId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE training_sessions SET judged_count = judged_count + 1
       WHERE id = ? AND student_id = ?
         AND status = 'in_progress'`,
      [id, studentId],
    );
  }
}
