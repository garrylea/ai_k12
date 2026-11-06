import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface UpsertAnswerInput {
  sessionId: number;
  questionId: number;
  questionOrder: number;
  answerText: string | null;
  isCorrect?: boolean | null;
  score?: number | null;
  method?: string | null;
  analysis?: string | null;
  judgedAt?: Date;
}

export interface UpsertSpecialAnswerInput {
  sessionId: number;
  questionOrder: number;
  refType: 'passage' | 'word';
  refId: number;
  sentenceIndex?: number | null;
  answerText: string | null;
  isCorrect?: boolean | null;
  score?: number | null;
  method?: string | null;
  analysis?: string | null;
  judgedAt?: Date;
}

export interface AnswerRow {
  id: number;
  session_id: number;
  question_id: number | null;
  ref_type: string | null;
  ref_id: number | null;
  sentence_index: number | null;
  question_order: number;
  answer_text: string | null;
  is_correct: number | null;
  score: string | number | null;
  method: string | null;
  analysis: string | null;
  judged_at: Date | null;
}

@Injectable()
export class SpecialAnswerRecordsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** question_id 非空：走 uniq_sar_session_q 的 ON DUPLICATE KEY UPDATE（与 exam_answers 一致）。 */
  async upsertAnswer(input: UpsertAnswerInput): Promise<void> {
    await this.pool.execute(
      `INSERT INTO special_answer_records
       (session_id, question_id, question_order, answer_text, is_correct, score, method, analysis, judged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       answer_text = VALUES(answer_text), is_correct = VALUES(is_correct), score = VALUES(score),
       method = VALUES(method), analysis = VALUES(analysis), judged_at = VALUES(judged_at)`,
      [
        input.sessionId, input.questionId, input.questionOrder, input.answerText,
        input.isCorrect === undefined ? null : input.isCorrect === null ? null : input.isCorrect ? 1 : 0,
        input.score ?? null, input.method ?? null, input.analysis ?? null, input.judgedAt ?? null,
      ],
    );
  }

  /**
   * question_id 为空：uniq_sar_session_q 唯键不生效（MySQL NULL 不去重）。
   * 先 DELETE 同 session+ref_type+ref_id+sentence_index 的旧行，再 INSERT。
   */
  async upsertSpecialAnswer(input: UpsertSpecialAnswerInput): Promise<void> {
    await this.pool.execute(
      `DELETE FROM special_answer_records
       WHERE session_id = ? AND ref_type = ? AND ref_id = ? AND sentence_index <=> ?`,
      [input.sessionId, input.refType, input.refId, input.sentenceIndex ?? null],
    );
    await this.pool.execute(
      `INSERT INTO special_answer_records
       (session_id, question_id, question_order, ref_type, ref_id, sentence_index,
        answer_text, is_correct, score, method, analysis, judged_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sessionId, input.questionOrder, input.refType, input.refId, input.sentenceIndex ?? null,
        input.answerText,
        input.isCorrect === undefined ? null : input.isCorrect === null ? null : input.isCorrect ? 1 : 0,
        input.score ?? null, input.method ?? null, input.analysis ?? null, input.judgedAt ?? null,
      ],
    );
  }

  /**
   * 数理化专项开练时保存整轮题单：未答的题写空行，历史详情才能显示「未作答」。
   *
   * 空作答 = 四列全 NULL（`answer_text` / `is_correct` / `score` / `method`），
   * `order` 由调用方显式给出（题单里的**原始位次**，1-based）：题单中间有题失效被跳过时，
   * 后一题仍保留原位次、不压缩——`upsertAnswer` 的 ON DUPLICATE KEY UPDATE 不重写
   * `question_order`，一旦压缩错位就是永久错。
   * `INSERT IGNORE` 打 `uniq_sar_session_q`：已判过的题由 upsertAnswer 写过，重复判题不产生重复行。
   */
  async ensurePlannedQuestions(
    sessionId: number,
    entries: Array<{ questionId: number; order: number }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const values = entries.map(() => '(?, ?, ?, NULL, NULL, NULL, NULL)').join(',');
    const params: Array<number> = [];
    entries.forEach((e) => params.push(sessionId, e.questionId, e.order));
    // 批量插入用 query（多行 VALUES 与仓内其它批量写一致）
    await this.pool.query(
      `INSERT IGNORE INTO special_answer_records
       (session_id, question_id, question_order, answer_text, is_correct, score, method)
       VALUES ${values}`,
      params,
    );
  }

  /** 按 session 列出作答（含 JOIN questions 题面）。 */
  async listBySession(sessionId: number): Promise<Array<AnswerRow & {
    question_content: string | null; question_answer: string | null; question_analysis: string | null;
    /** 题目在架标记（详情判断 canRedo / canSimilar）；题目无关联时为 null。 */
    question_is_active: number | null;
  }>> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT sar.*, q.content AS question_content, q.answer AS question_answer,
              q.explanation AS question_analysis, q.is_active AS question_is_active
       FROM special_answer_records sar
       LEFT JOIN questions q ON sar.question_id = q.id
       WHERE sar.session_id = ?
       ORDER BY sar.question_order`,
      [sessionId],
    );
    return rows as any;
  }

  /** 聚合作答数与正确数（列表"对x/y"用）。 */
  async countBySession(sessionId: number): Promise<{ total: number; correct: number }> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(is_correct = 1), 0) AS correct
       FROM special_answer_records WHERE session_id = ?`,
      [sessionId],
    );
    return { total: Number((rows[0] as any).total ?? 0), correct: Number((rows[0] as any).correct ?? 0) };
  }
}
