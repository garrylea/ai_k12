import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AdminPapersRepository,
  type AdminPaperListRow,
  type PaperImpact,
} from '../../database/repositories/admin-papers.repo.js';

export interface AdminPaperQuery {
  subjectId?: number;
  year?: number;
  gradeBand?: 'primary' | 'junior' | 'senior';
  keyword?: string;
  page: number;
  pageSize: number;
}

export interface AdminPaperItem {
  id: number;
  subjectId: number;
  subjectName: string;
  title: string;
  grade: string | null;
  gradeBand: string | null;
  semester: string | null;
  year: number | null;
  district: string | null;
  examType: string | null;
  sourceKey: string;
  questionCount: number;
  sessionCount: number;
  createdAt: string;
}

export interface AdminPaperListResult {
  items: AdminPaperItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminPaperDeletePreview extends PaperImpact {
  paperId: number;
  title: string;
  subjectName: string;
}

export interface AdminPaperDeleteResult {
  paperId: number;
  deletedQuestions: number;
  retainedQuestions: number;
  deletedSessions: number;
  deletedAnswers: number;
}

function toItem(row: AdminPaperListRow): AdminPaperItem {
  return {
    id: Number(row.id),
    subjectId: Number(row.subject_id),
    subjectName: row.subject_name,
    title: row.title,
    grade: row.grade,
    gradeBand: row.grade_band,
    semester: row.semester,
    year: row.year === null ? null : Number(row.year),
    district: row.district,
    examType: row.exam_type,
    sourceKey: row.source_key,
    questionCount: Number(row.linked_question_count),
    sessionCount: Number(row.session_count),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function isForeignKeyConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2';
}

/**
 * 管理端试卷管理：列表 / 删除预览 / 删除。
 *
 * 删除规则（spec §5）：只删独占题；共享题只解绑；被学生数据引用的独占题保留；
 * 该卷考试会话连同作答一并删除。仓储负责事务，本层只做 id 校验与错误转换。
 */
@Injectable()
export class AdminPapersService {
  constructor(private readonly repo: AdminPapersRepository) {}

  async list(query: AdminPaperQuery): Promise<AdminPaperListResult> {
    const { items, total } = await this.repo.findPapers(query);
    return { items: items.map(toItem), total, page: query.page, pageSize: query.pageSize };
  }

  async preview(id: number): Promise<AdminPaperDeletePreview> {
    this.assertId(id);
    const paper = await this.repo.findPaper(id);
    if (!paper) {
      throw new NotFoundException(`试卷不存在：${id}`);
    }
    const impact = await this.repo.countImpact(id);
    return {
      paperId: paper.id,
      title: paper.title,
      subjectName: paper.subjectName,
      ...impact,
    };
  }

  async remove(id: number): Promise<AdminPaperDeleteResult> {
    this.assertId(id);
    let outcome;
    try {
      outcome = await this.repo.deletePaperCascade(id);
    } catch (err) {
      if (isForeignKeyConflict(err)) {
        throw new HttpException({ code: 4201, message: '该试卷正在被使用，请刷新后重试' }, 409);
      }
      throw err;
    }
    if (!outcome) {
      throw new NotFoundException(`试卷不存在：${id}`);
    }
    return {
      paperId: id,
      deletedQuestions: outcome.deletedQuestions,
      retainedQuestions: outcome.retainedQuestions,
      deletedSessions: outcome.deletedSessions,
      deletedAnswers: outcome.deletedAnswers,
    };
  }

  private assertId(id: number): void {
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException({ code: 1001, message: '试卷 id 必须是正整数' });
    }
  }
}
