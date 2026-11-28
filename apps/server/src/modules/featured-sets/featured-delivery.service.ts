import {
  BadRequestException, Inject, Injectable, NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import {
  FeaturedQuestionSetsRepository,
  type FeaturedUnreadSummary,
  type StudentFeaturedPublication,
} from '../../database/repositories/featured-question-sets.repo.js';
import {
  SpecialPracticeSessionsRepository,
  type SpecialSessionModule,
} from '../../database/repositories/special-practice-sessions.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { resolveGradeInfo } from '../../common/utils/grade.js';
import { targetedSessionModule } from '../../common/subject-config.js';
import { toFeaturedRunQuestion, type FeaturedRunQuestion } from './featured-question-run.mapper.js';

export interface FeaturedRunPayload {
  mode: 'featured';
  sessionUid: string;
  subjectId: number;
  title: string;
  questions: FeaturedRunQuestion[];
}

/**
 * 学生精选题投递：列表 / 未读摘要只读；open 在单连接事务内
 * 「锁 publication → 建服务端 session → 标已读」，三步共用同一 executor，
 * 任一步失败一律 rollback 并抛原错误，绝不返回无服务端凭据的题单。
 */
@Injectable()
export class FeaturedDeliveryService {
  constructor(
    private readonly repository: FeaturedQuestionSetsRepository,
    private readonly specialSessionsRepo: SpecialPracticeSessionsRepository,
    private readonly studentsRepo: StudentsRepository,
    @Inject('DATABASE_POOL') private readonly pool: Pool,
  ) {}

  async list(
    studentId: number,
    page?: string | undefined,
  ): Promise<{ items: StudentFeaturedPublication[]; total: number }> {
    const p = page === undefined ? 1 : Number(page);
    if (!Number.isInteger(p) || p < 1) {
      throw new BadRequestException({ code: 1001, message: '页码必须是正整数' });
    }
    return this.repository.listStudentPublications(studentId, await this.gradeCode(studentId), p);
  }

  async unreadSummary(studentId: number): Promise<FeaturedUnreadSummary> {
    return this.repository.unreadSummary(studentId, await this.gradeCode(studentId));
  }

  /** 年级统一走 grade_N code，不把 students.grade 原始标签透传给仓储。 */
  private async gradeCode(studentId: number): Promise<string> {
    const student = await this.studentsRepo.findById(studentId);
    if (!student) throw new BadRequestException({ code: 1001, message: '学生不存在' });
    const grade = resolveGradeInfo(student.grade ?? '');
    if (!grade) throw new BadRequestException({ code: 1001, message: '无法解析学生年级' });
    return grade.code;
  }

  async open(studentId: number, publicationId: number): Promise<FeaturedRunPayload> {
    const gradeCode = await this.gradeCode(studentId);
    // 服务端生成并持有 sessionUid：运行器不得自行生成，否则判题无法识别 featured 会话。
    const sessionUid = randomUUID();

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      // FOR UPDATE 只在传入事务连接时真正锁行；连接必须透传到下面三次仓储调用。
      const pub = await this.repository.findOpenPublication(publicationId, gradeCode, conn);
      // 年级不匹配 / 已撤回 / 全部下架同口径 1002，不泄露 publication 是否存在、不写已读。
      if (!pub) {
        throw new NotFoundException({ code: 1002, message: '精选内容不存在或已下架' });
      }

      await this.specialSessionsRepo.upsertSession({
        sessionUid,
        studentId,
        subjectId: pub.subjectId,
        module: targetedSessionModule(pub.subjectId) as SpecialSessionModule,
        title: pub.title,
        questionCount: pub.questions.length,
        featuredPublicationId: publicationId,
      }, conn);

      await this.repository.markRead(publicationId, studentId, conn);
      await conn.commit();

      return {
        mode: 'featured',
        sessionUid,
        subjectId: pub.subjectId,
        title: pub.title,
        questions: pub.questions.map(toFeaturedRunQuestion),
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
}
