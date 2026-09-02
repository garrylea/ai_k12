import { BadRequestException, Body, Controller, Get, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { TrainingService } from './training.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { ErrorBookQueryDto } from './dto/error-book-query.dto.js';
import type { JudgeTrainingDto } from './dto/judge-training.dto.js';

@Controller('api/training')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class TrainingController {
  constructor(private readonly trainingService: TrainingService) {}

  /** 错题练习筛选列表：subjectId 必填；from/to/type 可选 string，kpId 可选 number。 */
  @Get('error-book')
  async getErrorBookEntries(
    @Query('subjectId', ParseIntPipe) subjectId: number,
    @CurrentUser() user: JwtUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('type') type?: string,
    @Query('kpId') kpIdStr?: string,
  ) {
    let kpId: number | undefined;
    if (kpIdStr !== undefined && kpIdStr !== '') {
      kpId = parseInt(kpIdStr, 10);
      if (Number.isNaN(kpId)) throw new BadRequestException('kpId 非法');
    }
    const filters: ErrorBookQueryDto = { from, to, type, kpId };
    return this.trainingService.getErrorBookEntries(user.sub, subjectId, filters);
  }

  /** 训练判题（题中心变体）：source 白名单校验，非训练来源一律 400。 */
  @Post('judge')
  async judge(@Body() dto: JudgeTrainingDto, @CurrentUser() user: JwtUser) {
    if (dto.source !== 'targeted' && dto.source !== 'error_practice') {
      throw new BadRequestException('source 仅允许 targeted | error_practice');
    }
    return this.trainingService.judgeTraining({
      studentId: user.sub,
      questionId: dto.questionId,
      subjectId: dto.subjectId,
      studentAnswer: dto.studentAnswer,
      source: dto.source,
    });
  }

  /** 仍错 bump：错题重做仍答错时提升 level（镜像 practice 的 bump-error-levels）。 */
  @Post('bump-error-levels')
  async bumpErrorLevels(
    @Body() dto: { errorBookIds: number[] },
    @CurrentUser() user: JwtUser,
  ) {
    return this.trainingService.bumpErrorLevels(dto.errorBookIds);
  }
}
