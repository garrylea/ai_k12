import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/** exam_sessions 行（会话全字段）。 */
export interface ExamSessionRow {
  id: number;
  student_id: number;
  paper_id: number;
  subject_id: number;
  status: string; // 'in_progress' | 'submitted'
  duration_minutes: number;
  started_at: Date;
  deadline_at: Date;
  submitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** exam_answers 行（逐题作答；is_correct NULL = 在途/未判）。 */
export interface ExamAnswerRow {
  id: number;
  session_id: number;
  question_id: number;
  question_order: number;
  answer_text: string | null;
  is_correct: number | null;
  method: string | null; // 'exact' | 'ai' | 'unanswered' | 'failed'
  analysis: string | null;
  error_type: string | null;
  judged_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** upsertAnswer 入参（isCorrect/method 等判题字段可缺省——在途作答只落 answerText）。 */
export interface UpsertAnswerRow {
  sessionId: number;
  questionId: number;
  questionOrder: number;
  answerText: string | null;
  isCorrect?: number;
  method?: string;
  analysis?: string | null;
  errorType?: string | null;
  judgedAt?: Date;
}

/** 结果页行：exam_answers JOIN questions（带 explanation）。 */
export interface ExamResultRow {
  question_id: number;
  question_order: number;
  answer_text: string | null;
  is_correct: number | null;
  analysis: string | null;
  text: string;
  type: string;
  options: string | null;
  explanation: string | null;
}

/**
 * 考试会话 repo（exams 模块 Task 2）。
 *
 * 会话生命周期：create（in_progress）-> upsertAnswer 逐题落答 ->
 * markSubmitted（手动交卷 / 超时自动收卷）。answer 落库走
 * uniq_ea_session_q 上的 ON DUPLICATE KEY UPDATE 幂等 upsert。
 */
@Injectable()
export class ExamSessionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 新建会话（status 走 DB 默认 'in_progress'），返回 insertId。 */
  async create(row: {
    studentId: number;
    paperId: number;
    subjectId: number;
    durationMinutes: number;
    deadlineAt: Date;
  }): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO exam_sessions (student_id, paper_id, subject_id, duration_minutes, deadline_at)
       VALUES (?, ?, ?, ?, ?)`,
      [row.studentId, row.paperId, row.subjectId, row.durationMinutes, row.deadlineAt],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<ExamSessionRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM exam_sessions WHERE id = ?`,
      [id],
    );
    return (rows[0] as ExamSessionRow) ?? null;
  }

  /** 同卷续考查找：该学生该卷唯一 in_progress 会话（最新一条）。 */
  async findInProgressByStudentPaper(studentId: number, paperId: number): Promise<ExamSessionRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM exam_sessions
       WHERE student_id = ? AND paper_id = ? AND status = 'in_progress'
       ORDER BY id DESC LIMIT 1`,
      [studentId, paperId],
    );
    return (rows[0] as ExamSessionRow) ?? null;
  }

  async markSubmitted(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE exam_sessions SET status = 'submitted', submitted_at = NOW(3) WHERE id = ?`,
      [id],
    );
  }

  /** 逐题作答幂等 upsert（同 session 同题覆盖作答/判题字段）。 */
  async upsertAnswer(row: UpsertAnswerRow): Promise<void> {
    await this.pool.execute(
      `INSERT INTO exam_answers
         (session_id, question_id, question_order, answer_text, is_correct, method, analysis, error_type, judged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         question_order = VALUES(question_order),
         answer_text = VALUES(answer_text),
         is_correct = VALUES(is_correct),
         method = VALUES(method),
         analysis = VALUES(analysis),
         error_type = VALUES(error_type),
         judged_at = VALUES(judged_at)`,
      [
        row.sessionId, row.questionId, row.questionOrder, row.answerText,
        row.isCorrect ?? null, row.method ?? null, row.analysis ?? null,
        row.errorType ?? null, row.judgedAt ?? null,
      ],
    );
  }

  async findAnswersBySession(sessionId: number): Promise<ExamAnswerRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM exam_answers WHERE session_id = ? ORDER BY question_order`,
      [sessionId],
    );
    return rows as ExamAnswerRow[];
  }

  /** 结果页查询：exam_answers JOIN questions 带 explanation（交卷后每题必有 answer 行）。 */
  async findAnswersWithQuestions(sessionId: number): Promise<ExamResultRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ea.question_id, ea.question_order, ea.answer_text, ea.is_correct, ea.analysis,
              q.content AS text, q.type, q.options, q.explanation
       FROM exam_answers ea JOIN questions q ON q.id = ea.question_id
       WHERE ea.session_id = ?
       ORDER BY ea.question_order`,
      [sessionId],
    );
    return rows as unknown as ExamResultRow[];
  }
}
