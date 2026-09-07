import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AiDialogueRow } from './types.js';

@Injectable()
export class AiDialoguesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<AiDialogueRow, 'id' | 'created_at' | 'updated_at' | 'deleted_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ai_dialogues
       (student_id, subject_id, track, scene, card_id, question_id, knowledge_point_id, title, status, consecutive_fail_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.student_id, row.subject_id, row.track, row.scene, row.card_id, row.question_id,
        row.knowledge_point_id, row.title, row.status, row.consecutive_fail_count,
      ],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<AiDialogueRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ai_dialogues WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return (rows[0] as AiDialogueRow) ?? null;
  }

  async findByStudentAndTrack(
    studentId: number,
    track: AiDialogueRow['track'],
    limit: number,
    cursor?: number,
    scene?: AiDialogueRow['scene'],
  ): Promise<AiDialogueRow[]> {
    // 用池 query（客户端转义）而非 execute（服务端预处理）：MySQL 对预处理语句的
    // `LIMIT ?` 报 "Incorrect arguments to mysqld_stmt_execute"。值仍经 mysql2 转义，无注入风险。
    const conditions = ['student_id = ?', 'track = ?', 'deleted_at IS NULL'];
    const params: Array<number | string> = [studentId, track];
    if (cursor) {
      conditions.push('id < ?');
      params.push(cursor);
    }
    if (scene) {
      conditions.push('scene = ?');
      params.push(scene);
    }
    params.push(limit);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM ai_dialogues
       WHERE ${conditions.join(' AND ')}
       ORDER BY id DESC LIMIT ?`,
      params,
    );
    return rows as AiDialogueRow[];
  }

  /**
   * 训练讲一讲 find-or-create：该学生该题（scene + question_id 锚）最近一条 active 会话。
   * 命中则复用（跨刷新/跨设备续接同一讨论线），未命中则由上层创建。
   * idx_dlg_student_scene_question(student_id, track, scene, question_id) 支撑此查询。
   */
  async findByStudentTrackSceneQuestion(
    studentId: number,
    track: AiDialogueRow['track'],
    scene: AiDialogueRow['scene'],
    questionId: number,
  ): Promise<AiDialogueRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ai_dialogues
       WHERE student_id = ? AND track = ? AND scene = ? AND question_id = ? AND deleted_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [studentId, track, scene, questionId],
    );
    return (rows[0] as AiDialogueRow) ?? null;
  }

  /**
   * 卡片级讨论 find-or-create：查找该学生在某卡片上的最近一条 mainline 对话。
   * 命中则复用（跨刷新/跨设备续接同一讨论线），未命中则由上层创建。
   * idx_dlg_student_card(student_id, track, card_id) 支撑此查询。
   */
  async findMainlineByStudentAndCard(studentId: number, cardId: number): Promise<AiDialogueRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ai_dialogues
       WHERE student_id = ? AND track = 'mainline' AND card_id = ? AND deleted_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [studentId, cardId],
    );
    return (rows[0] as AiDialogueRow) ?? null;
  }

  async updateTitle(id: number, title: string): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET title = ? WHERE id = ?`,
      [title, id],
    );
  }

  async archive(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET status = 'archived' WHERE id = ?`,
      [id],
    );
  }

  async softDelete(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET deleted_at = NOW() WHERE id = ?`,
      [id],
    );
  }

  async updateFailCount(id: number, count: number): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET consecutive_fail_count = ? WHERE id = ?`,
      [count, id],
    );
  }

  async incrementFailCount(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET consecutive_fail_count = consecutive_fail_count + 1 WHERE id = ?`,
      [id],
    );
  }

  /** P1: update the image two-stage flow state and the pending transcribed
   *  question(s). Pass null to clear pending fields (e.g. on confirm -> idle). */
  async updateFlowState(
    id: number,
    flowState: AiDialogueRow['flow_state'],
    pendingQuestion: string | null = null,
    pendingQuestions: string | null = null,
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET flow_state = ?, pending_question = ?, pending_questions = ? WHERE id = ?`,
      [flowState, pendingQuestion, pendingQuestions, id],
    );
  }
}
