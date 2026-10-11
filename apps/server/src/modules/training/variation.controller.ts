import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { VariationService } from './variation.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { SubmitVariationAnswerDto, VariationSelfAssessDto } from './dto/variation.dto.js';

/** 错题升级变式（PRD §7.10，2026-10-11）。
 *  生成由 `POST /api/training/bump-error-levels` 内 fire-and-forget 触发，本控制器只管下发与落定。 */
@Controller('api/training/variations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class VariationController {
  constructor(private readonly variationService: VariationService) {}

  /** pending 变式列表（错题本入口 + 重做结果页提示卡共用；200）。 */
  @Get('me')
  async me(@Query('errorBookId') errorBookId: string | undefined, @CurrentUser() user: JwtUser) {
    let filter: number | undefined;
    if (errorBookId != null && errorBookId !== '') {
      const parsed = Number(errorBookId);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new BadRequestException('errorBookId 非法');
      }
      filter = parsed;
    }
    return this.variationService.listPending(user.sub, filter);
  }

  /** 客观题判题 + 落定（201，Nest 默认；镜像 remediation/answers）。 */
  @Post('answers')
  async answer(@Body() dto: SubmitVariationAnswerDto, @CurrentUser() user: JwtUser) {
    if (!Number.isInteger(dto.questionId) || dto.questionId < 1) {
      throw new BadRequestException('questionId 非法');
    }
    if (typeof dto.studentAnswer !== 'string') throw new BadRequestException('studentAnswer 非法');
    return this.variationService.submitAnswer(user.sub, dto);
  }

  /** 主观题自评 + 落定（201，镜像 remediation/self-assess）。 */
  @Post('self-assess')
  async selfAssess(@Body() dto: VariationSelfAssessDto, @CurrentUser() user: JwtUser) {
    if (!Number.isInteger(dto.questionId) || dto.questionId < 1) {
      throw new BadRequestException('questionId 非法');
    }
    if (dto.assessment !== 'correct' && dto.assessment !== 'incorrect') {
      throw new BadRequestException('assessment 仅允许 correct | incorrect');
    }
    return this.variationService.selfAssess(user.sub, dto);
  }
}
