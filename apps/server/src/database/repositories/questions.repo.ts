import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { QuestionRow } from './types.js';
import { contentPrefix } from '../../common/utils/content-hash.util.js';

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

  /**
   * 题目前缀兜底匹配：hash 未命中时，用「归一化去标点后的前 20 字」比对，
   * 解决同一道题因文字/格式微调导致 hash 不一致的问题。先用前 6 字做
   * LIKE 粗筛（needle 无标点，能穿过题库内容的标点），再在 JS 里精确比对
   * 前缀；返回按 id 倒序（最新优先）的候选。
   */
  async findByContentPrefix(content: string, limit = 20): Promise<QuestionRow[]> {
    const prefix = contentPrefix(content);
    if (prefix.length < 4) return [];
    const needle = prefix.slice(0, Math.min(6, prefix.length));
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM questions WHERE is_active = 1 AND content LIKE CONCAT('%', ?, '%') ORDER BY id DESC LIMIT 50`,
      [needle],
    );
    return (rows as QuestionRow[]).filter((r) => contentPrefix(r.content) === prefix).slice(0, limit);
  }

  /** 题中心定位：按主键取在用题目（训练模块用，训练题必来自题库）。 */
  async findById(id: number): Promise<QuestionRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM questions WHERE id = ? AND is_active = 1`,
      [id],
    );
    return (rows[0] as QuestionRow) ?? null;
  }

  /** 判错解析缓存：LLM 生成/长答案直写后回写 questions.explanation。 */
  async updateExplanation(id: number, explanation: string): Promise<void> {
    await this.pool.execute(
      'UPDATE questions SET explanation = ? WHERE id = ?',
      [explanation, id],
    );
  }

  async create(row: Omit<QuestionRow, 'id' | 'created_at' | 'is_active'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO questions
       (subject_id, type, difficulty, content, options, answer, approach, explanation, source, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.subject_id, row.type, row.difficulty, row.content, row.options, row.answer, row.approach ?? null, row.explanation, row.source, row.content_hash],
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

  /** 该题绑定的知识点 id（掌握度回写用；无绑定返回空数组，不是 null）。 */
  async findKnowledgePointIdsByQuestion(questionId: number): Promise<number[]> {
    const [rows] = await this.pool.execute<(RowDataPacket & { knowledge_point_id: number })[]>(
      `SELECT knowledge_point_id FROM question_knowledge_points WHERE question_id = ?`,
      [questionId],
    );
    return rows.map((r) => Number(r.knowledge_point_id));
  }

  /**
   * 专项练习随机抽题（训练模块 Task 8）：按学科 + 知识点（JOIN qkp）随机取 count 题。
   * type 传 null 时不过滤题型；空答案题一律排除（判题体系重构 2026-09-09）：客观题判不了对，
   * 主观题（self_assess 模式）没有参考答案可对照自评——两类都不进专项练习。
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
        AND q.answer <> ''
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
