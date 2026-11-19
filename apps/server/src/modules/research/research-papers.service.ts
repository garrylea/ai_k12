import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import {
  ResearchPapersRepository,
  type AdminPaperListRow,
  type PaperImpact,
} from '../../database/repositories/research-papers.repo.js';
import { ContentAuditRepository } from '../../database/repositories/content-audit.repo.js';

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
 * 教研端试卷管理：列表 / 删除预览 / 删除（由 admin-papers.service.ts 迁移）。
 *
 * 删除规则（spec §5 / §7.4）：只删独占题；共享题只解绑；被学生数据引用的独占题保留；
 * 该卷考试会话连同作答一并删除。仓储负责事务，本层只做 id 校验与错误转换。
 * 删卷成功后写 `paper.delete` 审计；图片清理按计划边界留给 Task 7。
 */
@Injectable()
export class ResearchPapersService {
  constructor(
    private readonly repo: ResearchPapersRepository,
    private readonly audit: ContentAuditRepository,
  ) {}

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

  async remove(id: number, user: JwtUser & { name?: string | null }): Promise<AdminPaperDeleteResult> {
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
    await this.audit.append({
      actorId: user.sub,
      actorRole: user.role,
      actorName: user.name ?? null,
      action: 'paper.delete',
      targetType: 'paper',
      targetId: id,
      paperId: id,
    });
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
