import { BadRequestException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ResearchPapersRepository,
  type AdminPaperListRow,
  type PaperImpact,
} from '../../database/repositories/research-papers.repo.js';
import type { AuditActor } from '../../database/repositories/content-audit.repo.js';
import { parseOptions } from '../../common/utils/parse-options.util.js';
import { ResearchImagesService } from './research-images.service.js';

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

/** 教研端试卷详情：题目五字段给当前原值（与学生端相反，不剥离 answer/explanation/approach）。 */
export interface ResearchQuestionDetail {
  id: number;
  questionNo: number;
  subNo: number;
  type: string;
  content: string;
  options: unknown[] | null;
  answer: string;
  explanation: string | null;
  approach: string | null;
  source: string | null;
  sourceYear: number | null;
  answerVerified: boolean;
  isActive: boolean;
}

export interface ResearchPaperDetailResult {
  paper: Record<string, unknown>;
  questions: ResearchQuestionDetail[];
}

export interface AdminPaperDeleteResult {
  paperId: number;
  deletedQuestions: number;
  retainedQuestions: number;
  deletedSessions: number;
  deletedAnswers: number;
  deletedImages: number;
}

/** 试卷元信息：行是 `p.*`，统一把列名转 camelCase，Date 转 ISO 字符串。 */
function toPaperDetail(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase()),
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

/** 题目行 → DTO：字段名 camelCase，options 走 parseOptions 剥 isCorrect，五字段原样下发。 */
function toQuestionDetail(row: Record<string, unknown>): ResearchQuestionDetail {
  const str = (v: unknown) => (v == null ? '' : String(v));
  const nullableStr = (v: unknown) => (v == null ? null : String(v));
  const nullableNum = (v: unknown) => (v == null ? null : Number(v));
  return {
    id: Number(row.id),
    questionNo: Number(row.question_no),
    subNo: Number(row.sub_no ?? 0),
    type: str(row.type),
    content: str(row.content),
    options: parseOptions(row.options == null ? null : String(row.options)),
    answer: str(row.answer),
    explanation: nullableStr(row.explanation),
    approach: nullableStr(row.approach),
    source: nullableStr(row.source),
    sourceYear: nullableNum(row.source_year),
    answerVerified: Number(row.answer_verified) === 1,
    isActive: Number(row.is_active) === 1,
  };
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
 * 删卷成功后由仓储在同一事务内写 `paper.delete` 审计；随后清理可删独占题里的 research 图。
 */
@Injectable()
export class ResearchPapersService {
  private readonly logger = new Logger(ResearchPapersService.name);

  constructor(
    private readonly repo: ResearchPapersRepository,
    private readonly images: ResearchImagesService,
  ) {}

  async list(query: AdminPaperQuery): Promise<AdminPaperListResult> {
    const { items, total } = await this.repo.findPapers(query);
    return { items: items.map(toItem), total, page: query.page, pageSize: query.pageSize };
  }

  /** 试卷详情：元信息 + 题目列表，题目五字段给教研可见的当前原值。 */
  async detail(id: number): Promise<ResearchPaperDetailResult> {
    this.assertId(id);
    const data = await this.repo.findPaperDetail(id);
    if (!data) {
      throw new NotFoundException(`试卷不存在：${id}`);
    }
    return {
      paper: toPaperDetail(data.paper),
      questions: data.questions.map(toQuestionDetail),
    };
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

  async remove(id: number, actor: AuditActor): Promise<AdminPaperDeleteResult> {
    this.assertId(id);
    // 删之前先收图：用与级联删除同一套 exclusive/blocked 口径，只取真正会被物理删的题。
    const imageUrls = await this.repo.findResearchImageUrlsByPaper(id);
    let outcome;
    try {
      outcome = await this.repo.deletePaperCascade(id, actor);
    } catch (err) {
      if (isForeignKeyConflict(err)) {
        throw new HttpException({ code: 4201, message: '该试卷正在被使用，请刷新后重试' }, 409);
      }
      throw err;
    }
    if (!outcome) {
      throw new NotFoundException(`试卷不存在：${id}`);
    }
    // 事务已 commit：图片清理的任何失败只记日志，绝不让「已删成功的卷」对客户端报错。
    let deletedImages = 0;
    try {
      const cleanup = await this.images.cleanupUnreferenced(imageUrls, actor);
      deletedImages = cleanup.deleted;
    } catch (err) {
      this.logger.warn(`删卷后图片清理失败（卷已删除）：${String(err)}`);
    }
    return {
      paperId: id,
      deletedQuestions: outcome.deletedQuestions,
      retainedQuestions: outcome.retainedQuestions,
      deletedSessions: outcome.deletedSessions,
      deletedAnswers: outcome.deletedAnswers,
      deletedImages,
    };
  }

  private assertId(id: number): void {
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException({ code: 1001, message: '试卷 id 必须是正整数' });
    }
  }
}
