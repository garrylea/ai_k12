import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/**
 * 学生主观题自评留痕 repo（判题体系重构 2026-09-09）。
 *
 * short_answer/proof 在 JUDGE_SUBJECTIVE_MODE=self_assess 下不判对错，学生对照参考答案
 * 自评「我做对了/我做错了」；每次自评写一行（不复用、不 upsert——历史自评序列是
 * 学情分析与「自评 vs AI 一致率」的数据源）。错题本写入/清零不在此 repo，
 * 见 JudgeCoreService.recordSelfAssessment。
 */
@Injectable()
export class QuestionSelfAssessmentsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: {
    studentId: number;
    questionId: number;
    assessment: 'correct' | 'incorrect';
    source: string;
  }): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO question_self_assessments (student_id, question_id, assessment, source)
       VALUES (?, ?, ?, ?)`,
      [row.studentId, row.questionId, row.assessment, row.source],
    );
    return result.insertId;
  }

  /** 每题最近一次自评（考试结果页恢复自评状态用）；空列表直接返回空 Map 不发 SQL。 */
  async findLatestByStudentAndQuestionIds(
    studentId: number,
    questionIds: number[],
  ): Promise<Map<number, 'correct' | 'incorrect'>> {
    if (questionIds.length === 0) return new Map();
    const placeholders = questionIds.map(() => '?').join(',');
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT qsa.question_id, qsa.assessment
       FROM question_self_assessments qsa
       JOIN (SELECT question_id, MAX(id) AS max_id
             FROM question_self_assessments
             WHERE student_id = ? AND question_id IN (${placeholders})
             GROUP BY question_id) latest ON latest.max_id = qsa.id`,
      [studentId, ...questionIds],
    );
    return new Map(rows.map((r) => [r.question_id as number, r.assessment as 'correct' | 'incorrect']));
  }
}
