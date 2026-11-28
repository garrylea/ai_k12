import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { gradeInfoByCode, resolveGradeInfo } from '../../common/utils/grade.js';
import {
  FeaturedQuestionSetsRepository,
  type ReviewSetDetail,
  type ReviewStatus,
} from '../../database/repositories/featured-question-sets.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';

const REVIEW_STATUSES: ReviewStatus[] = ['pending', 'approved', 'rejected'];

/**
 * 教研审核：角色由 controller 的 @Roles('researcher') 守卫，service 只认 JWT sub 作为 reviewerId。
 * 状态前置校验走 getReviewSet（1002/1004），真正落库仍由仓储事务 + SQL 守卫兜底。
 */
@Injectable()
export class FeaturedReviewService {
  constructor(
    private readonly featuredRepo: FeaturedQuestionSetsRepository,
    private readonly studentsRepo: StudentsRepository,
  ) {}

  async list(status: string | undefined, page: string | undefined) {
    const st = (status ?? 'pending') as ReviewStatus;
    if (!REVIEW_STATUSES.includes(st)) {
      throw new BadRequestException({ code: 1001, message: '审核状态非法' });
    }
    const p = page === undefined ? 1 : Number(page);
    if (!Number.isInteger(p) || p < 1) {
      throw new BadRequestException({ code: 1001, message: '页码必须是正整数' });
    }
    // 仓储只返回 {items,total}；分页线格式由 service 补齐（pageSize 与仓储默认值一致）。
    const { items, total } = await this.featuredRepo.listReviewSets(st, p);
    return { items, page: p, pageSize: 20, total };
  }

  async detail(id: number): Promise<ReviewSetDetail> {
    const set = await this.featuredRepo.getReviewSet(id);
    if (!set) throw new NotFoundException({ code: 1002, message: '题集不存在' });
    return set;
  }

  async pendingCount(): Promise<{ count: number }> {
    const count = await this.featuredRepo.pendingCount();
    return { count };
  }

  /** 标题随每次发布独立写入该年级 publication，reachCount 是发布时的有效学生数快照。 */
  async publish(setId: number, raw: unknown, user: JwtUser): Promise<{ publicationId: number }> {
    const { title, gradeCode } = this.parsePublishBody(raw);
    const set = await this.detail(setId);
    if (set.reviewStatus === 'rejected') {
      throw new BadRequestException({ code: 1004, message: '已拒绝题集不能直接发布' });
    }
    const reachCount = await this.countActiveStudentsForGrade(gradeCode);
    return this.featuredRepo.publish({
      setId, title, gradeCode, reviewerId: user.sub, reachCount,
    });
  }

  /** 只数有效学生；students.grade 的历史写法由 resolveGradeInfo 收敛到 grade_N code。 */
  async countActiveStudentsForGrade(gradeCode: string): Promise<number> {
    const students = await this.studentsRepo.listAllActive();
    return students.filter((s) => resolveGradeInfo(s.grade ?? '')?.code === gradeCode).length;
  }

  async reject(setId: number, user: JwtUser): Promise<void> {
    const set = await this.detail(setId);
    if (set.reviewStatus !== 'pending') {
      throw new BadRequestException({ code: 1004, message: '只有 pending 题集可以拒绝' });
    }
    return this.featuredRepo.reject(setId, user.sub);
  }

  async reopen(setId: number): Promise<void> {
    const set = await this.detail(setId);
    if (set.reviewStatus !== 'rejected') {
      throw new BadRequestException({ code: 1004, message: '只有 rejected 题集可以重新审核' });
    }
    return this.featuredRepo.reopen(setId);
  }

  /** 仓储 withdraw 的 SQL 守卫 `WHERE id = ? AND status = 'published'` 负责只允许 published。 */
  async withdraw(publicationId: number, user: JwtUser): Promise<void> {
    return this.featuredRepo.withdraw(publicationId, user.sub);
  }

  private parsePublishBody(raw: unknown): { title: string; gradeCode: string } {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new BadRequestException({ code: 1001, message: '入参必须是对象' });
    }
    const { title, gradeCode } = raw as Record<string, unknown>;
    if (typeof title !== 'string' || title.trim().length < 1 || title.trim().length > 60) {
      throw new BadRequestException({ code: 1001, message: '标题必须为 1~60 字' });
    }
    if (typeof gradeCode !== 'string' || !gradeInfoByCode(gradeCode)) {
      throw new BadRequestException({ code: 1001, message: '年级编码非法' });
    }
    return { title: title.trim(), gradeCode };
  }
}
