import { Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { PracticeHistoryService } from './practice-history.service.js';
import type { PracticeHistoryDetail, PracticeHistoryListResult } from './practice-history.dto.js';
import type { HistoryRunQuestion } from '../training/history-practice.service.js';

/**
 * 学生端「练习记录」（Task 4，2026-11-01）。
 *
 * 两条只读端点：列表（考试 + 专项 UNION）+ 详情（逐题作答）。
 * 归属校验只用 JWT 的 studentId（防 IDOR），不接受 body 里的 studentId。
 */
@Controller('api/student/practice-history')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class PracticeHistoryController {
  constructor(private readonly service: PracticeHistoryService) {}

  /** 列表。query 全可选；非法数字静默回默认值（与项目其它列表端点同口径）。 */
  @Get()
  async list(
    @Query('page') pageStr: string | undefined,
    @Query('pageSize') pageSizeStr: string | undefined,
    @Query('subjectId') subjectIdStr: string | undefined,
    @CurrentUser() user: JwtUser,
  ): Promise<PracticeHistoryListResult> {
    const page = pageStr !== undefined ? parseInt(pageStr, 10) : undefined;
    const pageSize = pageSizeStr !== undefined ? parseInt(pageSizeStr, 10) : undefined;
    const subjectId = subjectIdStr !== undefined ? parseInt(subjectIdStr, 10) : undefined;
    return this.service.list({
      studentId: user.sub,
      page: Number.isNaN(page as number) ? undefined : page,
      pageSize: Number.isNaN(pageSize as number) ? undefined : pageSize,
      subjectId: Number.isNaN(subjectId as number) ? undefined : subjectId,
    });
  }

  /** 详情。source 仅 exam|special；会话不存在或非本人一律 404（不泄露存在性）。 */
  @Get(':source/:sessionId')
  async detail(
    @Param('source') source: string,
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @CurrentUser() user: JwtUser,
  ): Promise<PracticeHistoryDetail> {
    if (source !== 'exam' && source !== 'special') {
      throw new NotFoundException({ code: 1002, message: '记录不存在' });
    }
    const detail = await this.service.getDetail({
      studentId: user.sub,
      source,
      sessionId,
    });
    if (!detail) throw new NotFoundException({ code: 1002, message: '记录不存在' });
    return detail;
  }

  /**
   * 单题重做（2026-11-06）。
   *
   * 只回放这一道原题（白名单字段，不含答案/解析），不建会话、不写作答、不发分。
   * 归属不通过一律 404；题已下架 400（service 抛 BadRequestException）。
   */
  @Post(':source/:sessionId/questions/:questionId/redo')
  async redo(
    @Param('source') source: string,
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('questionId', ParseIntPipe) questionId: number,
    @CurrentUser() user: JwtUser,
  ): Promise<{ questions: HistoryRunQuestion[]; title: string }> {
    if (source !== 'exam' && source !== 'special') {
      throw new NotFoundException({ code: 1002, message: '记录不存在' });
    }
    const res = await this.service.redo({ studentId: user.sub, source, sessionId, questionId });
    if (!res) throw new NotFoundException({ code: 1002, message: '记录不存在' });
    return res;
  }
}
