import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/** exam_papers 行（列表投影）。 */
export interface ExamPaperRow {
  id: number;
  title: string;
  year: number | null;
  district: string | null;
  exam_type: string | null;
  grade_band: string | null;
  question_count: number;
}

/** 试卷题目元数据行（paper_questions JOIN questions，不含 answer/explanation）。 */
export interface PaperQuestionRow {
  questionId: number;
  questionNo: number;
  text: string;
  type: string;
  options: string | null;
}

/**
 * 试卷 repo（exams 模块 Task 1）。
 *
 * 只读查询：列表筛选 / 详情 / 题目元数据 JOIN。repos 通过
 * @Inject('DATABASE_POOL') 注入全局连接池（DatabaseModule 是 @Global）。
 */
@Injectable()
export class ExamPapersRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 试卷列表：subjectId 必填，year/district/examType/gradeBand 可选叠加筛选。 */
  async findPapers(filters: {
    subjectId: number;
    year?: number;
    district?: string;
    examType?: string;
    gradeBand?: string;
  }): Promise<ExamPaperRow[]> {
    const where: string[] = ['subject_id = ?'];
    const params: Array<number | string> = [filters.subjectId];
    if (filters.year !== undefined) {
      where.push('year = ?');
      params.push(filters.year);
    }
    if (filters.district !== undefined && filters.district !== '') {
      where.push('district = ?');
      params.push(filters.district);
    }
    if (filters.examType !== undefined && filters.examType !== '') {
      where.push('exam_type = ?');
      params.push(filters.examType);
    }
    if (filters.gradeBand !== undefined && filters.gradeBand !== '') {
      where.push('grade_band = ?');
      params.push(filters.gradeBand);
    }
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, title, year, district, exam_type, grade_band, question_count
       FROM exam_papers WHERE ${where.join(' AND ')} ORDER BY year DESC, id DESC`,
      params,
    );
    return rows as unknown as ExamPaperRow[];
  }

  async findById(id: number): Promise<ExamPaperRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, title, year, district, exam_type, grade_band, question_count
       FROM exam_papers WHERE id = ?`,
      [id],
    );
    return (rows[0] as unknown as ExamPaperRow) ?? null;
  }

  /** 试卷题目元数据（仅激活题，按卷内题号排序；不含 answer/explanation 列）。 */
  async findQuestionsByPaperId(paperId: number): Promise<PaperQuestionRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT q.id AS questionId, pq.question_no AS questionNo, q.content AS text, q.type, q.options
       FROM paper_questions pq JOIN questions q ON q.id = pq.question_id
       WHERE pq.paper_id = ? AND q.is_active = 1 ORDER BY pq.question_no`,
      [paperId],
    );
    return rows as unknown as PaperQuestionRow[];
  }
}
