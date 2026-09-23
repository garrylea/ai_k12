import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { KnowledgeGraphService } from './knowledge-graph.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { KnowledgeGraphMastery, WeakPointRecommendation } from './dto/knowledge-graph.dto.js';

/** 本期只支持数学（spec §2/§3 裁决 1）。 */
const MATH_SUBJECT_ID = 1;

/** `limit` 默认值与上界（spec §5.3）。 */
const DEFAULT_LIMIT = 1;
const MAX_LIMIT = 10;

/**
 * 数学薄弱点图谱（API 文档 §4.5）。
 *
 * **只读**：两个 GET 都不写库、不发分。归属校验用「URL 段 studentId 必须等于 JWT sub」，
 * 不符一律 403 —— ⚠️ **必须显式传 `code: 1005`**：`HttpExceptionFilter.httpStatusToCode`
 * 对 403 的默认值是 1003（那是 token 失效码），不传会给出误导性的错误码。
 */
@Controller('api/knowledge-graph')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class KnowledgeGraphController {
  constructor(private readonly service: KnowledgeGraphService) {}

  /** 全树 + 掌握度 overlay。 */
  @Get('students/:studentId/mastery')
  async getMastery(
    @Param('studentId', ParseIntPipe) studentId: number,
    @CurrentUser() user: JwtUser,
    @Query('subjectId', ParseIntPipe) subjectId: number,
  ): Promise<KnowledgeGraphMastery> {
    this.assertSelf(studentId, user.sub);
    this.assertMathSubject(subjectId);
    return this.service.getMastery(studentId, subjectId);
  }

  /** 薄弱点候选 + 一条推荐。无候选仍 200（`recommendation: null`）。 */
  @Get('students/:studentId/weak-points')
  async getWeakPoints(
    @Param('studentId', ParseIntPipe) studentId: number,
    @CurrentUser() user: JwtUser,
    @Query('subjectId', ParseIntPipe) subjectId: number,
    @Query('limit') limitStr?: string,
  ): Promise<WeakPointRecommendation> {
    this.assertSelf(studentId, user.sub);
    this.assertMathSubject(subjectId);

    // 空串等同缺省（前端 URLSearchParams 不会产出空串，但手拼 URL 会）
    const limit =
      limitStr === undefined || limitStr === ''
        ? DEFAULT_LIMIT
        : Number(limitStr);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequestException({ code: 1001, message: `limit 仅允许 1-${MAX_LIMIT} 的整数` });
    }

    return this.service.getWeakPoints(studentId, subjectId, limit);
  }

  /** URL 段 studentId 必须是登录者本人（防 IDOR）。 */
  private assertSelf(studentId: number, selfId: number): void {
    if (studentId !== selfId) {
      throw new ForbiddenException({ code: 1005, message: '无权访问该资源' });
    }
  }

  /** 本期只支持数学。 */
  private assertMathSubject(subjectId: number): void {
    if (subjectId !== MATH_SUBJECT_ID) {
      throw new BadRequestException({ code: 1001, message: 'subjectId 仅支持 1（数学）' });
    }
  }
}
