import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { HiddenQuestionListRow } from './types.js';

/**
 * 学生「不再展示」清单 repo。
 *
 * 仅服务专项训练选题排除（TrainingService.startTargetedPractice -> QuestionsRepository
 * .findRandomByKpAndType 的 LEFT JOIN）。其他选题路径（主线练习/错题重做/考试）不读此表。
 *
 * 防御性 WHERE：unmark/unmarkAll 一律含 student_id，避免 IDOR（学生只能撤销自己的标记）。
 * 幂等：mark 走 INSERT IGNORE（UNIQUE 约束兜底），unmark 删 0 行也不报错。
 */
@Injectable()
export class StudentHiddenQuestionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 标记：INSERT IGNORE 幂等（重复标记不报错，UNIQUE 约束兜底）。 */
  async mark(studentId: number, subjectId: number, questionId: number): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO student_hidden_questions (student_id, subject_id, question_id)
       VALUES (?, ?, ?)`,
      [studentId, subjectId, questionId],
    );
  }

  /** 撤销单条：归属校验防 IDOR（WHERE 含 student_id）。返回删除行数。 */
  async unmark(studentId: number, questionId: number): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM student_hidden_questions WHERE student_id = ? AND question_id = ?`,
      [studentId, questionId],
    );
    return result.affectedRows;
  }

  /** 全部重置：清空该生所有隐藏标记。返回删除行数。 */
  async unmarkAll(studentId: number): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM student_hidden_questions WHERE student_id = ?`,
      [studentId],
    );
    return result.affectedRows;
  }

  /** 清单：JOIN questions 取题面预览（SUBSTRING 80 字截断）+ 相关子查询取首个 primary kp 名。 */
  async findAllByStudent(studentId: number, subjectId: number): Promise<HiddenQuestionListRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT shq.question_id AS questionId,
              SUBSTRING(q.content, 1, 80) AS questionText,
              q.type,
              (SELECT kp.name FROM question_knowledge_points qkp
               JOIN knowledge_points kp ON kp.id = qkp.knowledge_point_id
               WHERE qkp.question_id = q.id AND qkp.role = 'primary' LIMIT 1) AS kpName,
              shq.created_at AS markedAt
       FROM student_hidden_questions shq
       JOIN questions q ON q.id = shq.question_id
       WHERE shq.student_id = ? AND shq.subject_id = ?
       ORDER BY shq.created_at DESC`,
      [studentId, subjectId],
    );
    return rows as HiddenQuestionListRow[];
  }
}
