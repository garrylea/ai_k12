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

  async create(row: Omit<QuestionRow, 'id' | 'created_at' | 'is_active'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO questions
       (subject_id, type, difficulty, content, options, answer, explanation, source, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.subject_id, row.type, row.difficulty, row.content, row.options, row.answer, row.explanation, row.source, row.content_hash],
    );
    return result.insertId;
  }

  async bindKnowledgePoint(questionId: number, knowledgePointId: number, role = 'primary'): Promise<void> {
    await this.pool.execute(
      `INSERT IGNORE INTO question_knowledge_points (question_id, knowledge_point_id, role) VALUES (?, ?, ?)`,
      [questionId, knowledgePointId, role],
    );
  }
}
