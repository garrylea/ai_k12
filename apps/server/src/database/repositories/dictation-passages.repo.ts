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
}

const SELECT_COLS = `dp.id, dp.question_id, dp.work_title, dp.author, dp.dynasty, dp.body,
  dp.grade_band, dp.grade, dp.semester, dp.sort_order, dp.source_ref, dp.verified,
  q.content AS questionContent`;

/**
 * 语文古诗文默写篇目 repo。
 * 只向抽题池暴露 verified=1 的篇目（校验闸门，spec §6）；导入侧用 upsert 写全量。
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
       WHERE q.subject_id = ? AND q.is_active = 1 AND dp.verified = 1
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
    let sql = `SELECT ${SELECT_COLS} FROM dictation_passages dp
       JOIN questions q ON q.id = dp.question_id
       LEFT JOIN student_hidden_questions shq
         ON shq.question_id = dp.question_id AND shq.student_id = ?
       WHERE q.subject_id = ? AND q.is_active = 1 AND dp.verified = 1
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
       WHERE q.subject_id = ? AND q.is_active = 1 AND dp.verified = 1
         AND dp.question_id IN (${placeholders})`,
      [subjectId, ...questionIds],
    );
    return rows;
  }

  /** 按 (work_title, semester) 业务主键 upsert：正文修正后重跑仍更新同一行（幂等）。 */
  async upsert(row: DictationUpsertInput): Promise<void> {
    await this.pool.execute(
      `INSERT INTO dictation_passages
         (question_id, work_title, author, dynasty, body, grade_band, grade, semester,
          sort_order, source_ref, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         question_id = VALUES(question_id), author = VALUES(author), dynasty = VALUES(dynasty),
         body = VALUES(body), grade_band = VALUES(grade_band), grade = VALUES(grade),
         sort_order = VALUES(sort_order), source_ref = VALUES(source_ref), verified = VALUES(verified)`,
      [
        row.questionId, row.workTitle, row.author, row.dynasty, row.body,
        row.gradeBand, row.grade, row.semester, row.sortOrder, row.sourceRef, row.verified,
      ],
    );
  }
}
