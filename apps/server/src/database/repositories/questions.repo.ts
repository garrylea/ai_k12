import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { QuestionRow } from './types.js';

@Injectable()
export class QuestionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findByContentHash(contentHash: string): Promise<QuestionRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM questions WHERE content_hash = ? AND is_active = 1`,
      [contentHash],
    );
    return (rows[0] as QuestionRow) ?? null;
  }

  /** 题中心定位：按主键取在用题目（训练模块用，训练题必来自题库）。 */
  async findById(id: number): Promise<QuestionRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM questions WHERE id = ? AND is_active = 1`,
      [id],
    );
    return (rows[0] as QuestionRow) ?? null;
  }

  async create(row: Omit<QuestionRow, 'id' | 'created_at' | 'is_active'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO questions
       (subject_id, type, difficulty, content, options, answer, explanation, source, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.subject_id, row.type, row.difficulty, row.content, row.options, row.answer, row.explanation, row.source, row.content_hash],
    );
    return result.insertId;
  }

  /**
   * Race-safe dedup: find by content_hash, else create. The UNIQUE constraint on
   * content_hash catches the TOCTOU race (two concurrent inserts with same hash);
   * ER_DUP_ENTRY is caught and resolved by re-reading the existing row.
   */
  async findOrCreate(row: Omit<QuestionRow, 'id' | 'created_at' | 'is_active'>): Promise<{ id: number; created: boolean }> {
    const existing = await this.findByContentHash(row.content_hash);
    if (existing) return { id: existing.id, created: false };
    try {
      const id = await this.create(row);
      return { id, created: true };
    } catch (err: any) {
      // ER_DUP_ENTRY: race condition - another request inserted the same hash
      if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
        const existing = await this.findByContentHash(row.content_hash);
        if (existing) return { id: existing.id, created: false };
      }
      throw err;
    }
  }

  async deleteById(id: number): Promise<void> {
    await this.pool.execute(`DELETE FROM questions WHERE id = ?`, [id]);
  }

  async bindKnowledgePoint(questionId: number, knowledgePointId: number, role = 'primary'): Promise<void> {
    await this.pool.execute(
      `INSERT IGNORE INTO question_knowledge_points (question_id, knowledge_point_id, role) VALUES (?, ?, ?)`,
      [questionId, knowledgePointId, role],
    );
  }
}
