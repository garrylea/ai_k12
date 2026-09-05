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

  /**
   * 专项练习随机抽题（训练模块 Task 8）：按学科 + 知识点（JOIN qkp）随机取 count 题。
   * type 传 null 时不过滤题型；choice/true_false 空答案题一律排除（终审备忘：
   * 判不了对的题不进专项练习）。
   *
   * 「不再展示」排除（2026-09-04）：LEFT JOIN student_hidden_questions，
   * 该生已标记的题 shq.id 非空 -> WHERE shq.id IS NULL 过滤掉。
   * studentId 由 TrainingService 从 controller JWT user.sub 透传。
   */
  async findRandomByKpAndType(
    studentId: number,
    subjectId: number,
    kpId: number,
    type: string | null,
    count: number,
  ): Promise<QuestionRow[]> {
    const typeFilter = type != null ? ' AND q.type = ?' : '';
    const sql = `SELECT q.* FROM questions q
      JOIN question_knowledge_points qkp ON qkp.question_id = q.id
      LEFT JOIN student_hidden_questions shq
        ON shq.question_id = q.id AND shq.student_id = ?
      WHERE q.subject_id = ? AND qkp.knowledge_point_id = ? AND q.is_active = 1${typeFilter}
        AND NOT (q.type IN ('choice','true_false') AND q.answer = '')
        AND shq.id IS NULL
      ORDER BY RAND() LIMIT ?`;
    const params = type != null
      ? [studentId, subjectId, kpId, type, count]
      : [studentId, subjectId, kpId, count];
    // Use pool.query (client-side escaping) instead of pool.execute (server-side
    // prepared statements): MySQL rejects `LIMIT ?` as a prepared-statement
    // placeholder with "Incorrect arguments to mysqld_stmt_execute"（联调实测；
    // 与 ai-dialogues.repo.ts findByStudentAndTrack 同款处理）。? 值仍经 mysql2
    // 转义，无注入风险。
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    return rows as QuestionRow[];
  }
}
