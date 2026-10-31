import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/** exam_papers 行（列表投影）。subject_id 仅 findById 投影携带（建会话需学科；列表映射不透出）。 */
export interface ExamPaperRow {
  id: number;
  subject_id?: number;
  title: string;
  year: number | null;
  district: string | null;
  exam_type: string | null;
  grade_band: string | null;
  question_count: number;
}

/** 试卷题目元数据行（paper_questions JOIN questions，不含 answer/explanation 正文）。
 *  `hasAnswer` 只暴露布尔标记（1 = 有参考答案；0 = 空答案，交卷时不入错题本）；服务端内部用，
 *  不进 toSessionQuestion，对客户端不可见。 */
export interface PaperQuestionRow {
  questionId: number;
  questionNo: number;
  text: string;
  type: string;
  options: string | null;
  /** 同节共享材料（语文阅读/文段题）；数学卷为 null。 */
  materialText: string | null;
  /** 1 = 有参考答案；0 = 空答案（判不了分，交卷时不入错题本）。 */
  hasAnswer: number;
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
    const where: string[] = ['p.subject_id = ?'];
    const params: Array<number | string> = [filters.subjectId];
    if (filters.year !== undefined) {
      where.push('p.year = ?');
      params.push(filters.year);
    }
    if (filters.district !== undefined && filters.district !== '') {
      where.push('p.district = ?');
      params.push(filters.district);
    }
    if (filters.examType !== undefined && filters.examType !== '') {
      where.push('p.exam_type = ?');
      params.push(filters.examType);
    }
    if (filters.gradeBand !== undefined && filters.gradeBand !== '') {
      where.push('p.grade_band = ?');
      params.push(filters.gradeBand);
    }
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT p.id, p.title, p.year, p.district, p.exam_type, p.grade_band,
              (SELECT COUNT(*) FROM paper_questions pq
                 JOIN questions q ON q.id = pq.question_id
                WHERE pq.paper_id = p.id AND pq.in_exam = 1 AND q.is_active = 1) AS question_count
       FROM exam_papers p WHERE ${where.join(' AND ')}
       ORDER BY p.year DESC, p.id DESC`,
      params,
    );
    return rows as unknown as ExamPaperRow[];
  }

  async findById(id: number): Promise<ExamPaperRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, subject_id, title, year, district, exam_type, grade_band, question_count
       FROM exam_papers WHERE id = ?`,
      [id],
    );
    return (rows[0] as unknown as ExamPaperRow) ?? null;
  }

  /** 试卷题目元数据（仅激活题 + 进入考试的题，按卷内题号排序；不含 answer/explanation 列，
   *  但带 hasAnswer 标记：交卷时无参考答案的题不入错题本）。 */
  async findQuestionsByPaperId(paperId: number): Promise<PaperQuestionRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT q.id AS questionId, pq.question_no AS questionNo, q.content AS text, q.type,
              q.options, q.material_text AS materialText,
              (q.answer IS NOT NULL AND TRIM(q.answer) <> '') AS hasAnswer
       FROM paper_questions pq JOIN questions q ON q.id = pq.question_id
       WHERE pq.paper_id = ? AND q.is_active = 1 AND pq.in_exam = 1
       ORDER BY pq.question_no`,
      [paperId],
    );
    return rows as unknown as PaperQuestionRow[];
  }
}
