import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface DictationPassageRow extends RowDataPacket {
  id: number;
  question_id: number;
  work_title: string;
  author: string;
  dynasty: string;
  body: string;
  grade_band: string;
  grade: string | null;
  semester: string;
  sort_order: number;
  source_ref: string | null;
  verified: number;
  memorize_required: number;
}

export interface DictationListRow extends DictationPassageRow {
  questionContent: string;
}

export interface DictationUpsertInput {
  questionId: number;
  workTitle: string;
  author: string;
  dynasty: string;
  body: string;
  gradeBand: string;
  grade: string | null;
  semester: string;
  sortOrder: number;
  sourceRef: string | null;
  verified: number;
  memorizeRequired: number;
}

const SELECT_COLS = `dp.id, dp.question_id, dp.work_title, dp.author, dp.dynasty, dp.body,
  dp.grade_band, dp.grade, dp.semester, dp.sort_order, dp.source_ref, dp.verified,
  dp.memorize_required,
  q.content AS questionContent`;

/**
 * 语文古诗文默写篇目 repo。
 * 只向抽题池暴露 `verified=1` **且** `memorize_required=1` 的篇目（两道闸门，spec §6）：
 * `verified` 是内容校验（正文准确），`memorize_required` 是教学上是否要求背诵。
 * 导入侧用 upsert 写全量（含未校验、未标必背的）。
 */
@Injectable()
export class DictationPassagesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findByQuestionId(questionId: number): Promise<DictationPassageRow | null> {
    const [rows] = await this.pool.execute<DictationPassageRow[]>(
      `SELECT ${SELECT_COLS} FROM dictation_passages dp
       JOIN questions q ON q.id = dp.question_id
       WHERE dp.question_id = ? LIMIT 1`,
      [questionId],
    );
    return rows[0] ?? null;
  }

  async findVerifiedBySubject(subjectId: number): Promise<DictationListRow[]> {
    const [rows] = await this.pool.execute<DictationListRow[]>(
      `SELECT ${SELECT_COLS} FROM dictation_passages dp
       JOIN questions q ON q.id = dp.question_id
       WHERE q.subject_id = ? AND q.is_active = 1 AND dp.verified = 1 AND dp.memorize_required = 1
       ORDER BY dp.sort_order, dp.id`,
      [subjectId],
    );
    return rows;
  }

  async findRandomVerified(
    studentId: number,
    subjectId: number,
    semester: string | null,
    count: number,
  ): Promise<DictationListRow[]> {
    const params: unknown[] = [studentId, subjectId];
    // 抽题池 = 已校验 且 必背：verified 只说内容对，memorize_required 才是教学上要背的。
    let sql = `SELECT ${SELECT_COLS} FROM dictation_passages dp
       JOIN questions q ON q.id = dp.question_id
       LEFT JOIN student_hidden_questions shq
         ON shq.question_id = dp.question_id AND shq.student_id = ?
       WHERE q.subject_id = ? AND q.is_active = 1 AND dp.verified = 1 AND dp.memorize_required = 1
         AND shq.id IS NULL`;
    if (semester != null) {
      sql += ' AND dp.semester = ?';
      params.push(semester);
    }
    sql += ' ORDER BY RAND() LIMIT ?';
    params.push(count);
    // LIMIT ? 不能走 prepared statement（mysql2 execute 报 Incorrect arguments），用 query
    const [rows] = await this.pool.query<DictationListRow[]>(sql, params);
    return rows;
  }

  async findVerifiedByQuestionIds(subjectId: number, questionIds: number[]): Promise<DictationListRow[]> {
    if (questionIds.length === 0) return [];
    const placeholders = questionIds.map(() => '?').join(',');
    const [rows] = await this.pool.execute<DictationListRow[]>(
      `SELECT ${SELECT_COLS} FROM dictation_passages dp
       JOIN questions q ON q.id = dp.question_id
       WHERE q.subject_id = ? AND q.is_active = 1 AND dp.verified = 1 AND dp.memorize_required = 1
         AND dp.question_id IN (${placeholders})`,
      [subjectId, ...questionIds],
    );
    return rows;
  }

  /**
   * 按 (work_title, semester) 业务主键 upsert：正文修正后重跑仍更新同一行（幂等）。
   *
   * ⚠️ 注意：**这里按入参覆盖 `memorize_required`**（调用方显式给出该值，如后台管理/
   * 开发种子）。内容管线的 loader（`tools/data-refinery/src/dictation_loader.py`）
   * **刻意不在它的冲突分支动这一列**——否则重跑管线会把用户标好的「必背」刷回 0。
   * 两处写法**不一致是有意的**，不要为了「统一」把 loader 也改成覆盖。
   */
  async upsert(row: DictationUpsertInput): Promise<void> {
    await this.pool.execute(
      `INSERT INTO dictation_passages
         (question_id, work_title, author, dynasty, body, grade_band, grade, semester,
          sort_order, source_ref, verified, memorize_required)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         question_id = VALUES(question_id), author = VALUES(author), dynasty = VALUES(dynasty),
         body = VALUES(body), grade_band = VALUES(grade_band), grade = VALUES(grade),
         sort_order = VALUES(sort_order), source_ref = VALUES(source_ref), verified = VALUES(verified),
         memorize_required = VALUES(memorize_required)`,
      [
        row.questionId, row.workTitle, row.author, row.dynasty, row.body,
        row.gradeBand, row.grade, row.semester, row.sortOrder, row.sourceRef, row.verified,
        row.memorizeRequired,
      ],
    );
  }
}
