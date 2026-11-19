import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { ContentAuditRepository, type AuditEntry } from './content-audit.repo.js';

/** 题目更正所需的最小行：五字段 + 核验标记 + 去重哈希（只比对，不更新）。 */
export interface QuestionRow extends RowDataPacket {
  id: number;
  answer: string;
  answer_verified: number;
  content_hash: string | null;
  content: string;
  options: string | null;
  explanation: string | null;
  approach: string | null;
}

/** 只用到 execute 的最小执行器接口（Pool 与 PoolConnection 都满足）。 */
type Queryable = { execute(sql: string, values?: unknown): Promise<unknown> };

/**
 * 教研题目更正仓储。
 *
 * `updateWithAudit` 沿用 Task 4 删卷的同口径（spec §9.2）：题目 UPDATE 与
 * `question.update` 审计必须在同一事务的同一连接上；审计插不进去就整笔回滚，
 * 题目不改。keys 由 service 侧 zod 白名单收敛，无 SQL 注入风险。
 */
@Injectable()
export class ResearchQuestionsRepository {
  constructor(
    @Inject('DATABASE_POOL') private readonly pool: Pool,
    private readonly audit: ContentAuditRepository,
  ) {}

  async findById(id: number): Promise<QuestionRow | null> {
    const [rows] = await this.pool.execute<QuestionRow[]>(
      `SELECT id, answer, answer_verified, content_hash, content, options, explanation, approach
         FROM questions WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** 反查该题所属任一试卷（审计 paper_id），无关联返回 null。 */
  async findPaperIdByQuestion(id: number): Promise<number | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT paper_id FROM paper_questions WHERE question_id = ? ORDER BY paper_id LIMIT 1`,
      [id],
    );
    return rows[0] ? Number(rows[0].paper_id) : null;
  }

  /**
   * 单事务：UPDATE questions（按需置 answer_verified=1）→ 同 conn 写审计 → commit。
   * 任一环节失败都 rollback 并原样抛出；conn 总是 release。
   */
  async updateWithAudit(
    id: number,
    fields: Record<string, unknown>,
    markVerified: boolean,
    audit: AuditEntry,
  ): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) {
      throw new BadRequestException({ code: 1001, message: '无变更字段' });
    }
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const params: Array<string | number | null> = keys.map((k) => fields[k] as string | number | null);
    if (markVerified) params.push(1);

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE questions SET ${sets}${markVerified ? ', answer_verified = 1' : ''} WHERE id = ?`,
        [...params, id],
      );
      await this.audit.appendOnConnection(conn as Queryable, audit);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
}
