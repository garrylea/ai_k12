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

  /** 专项练习允许的题型白名单（null = 不过滤题型）。 */
  private static readonly TARGETED_TYPES = ['choice', 'fill_blank', 'true_false', 'short_answer', 'proof'] as const;

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

  /** 仍错 bump：错题重做仍答错时提升 level（镜像 practice 的 bump-error-levels）。传 user.sub 做归属校验（防 IDOR）。 */
  @Post('bump-error-levels')
  async bumpErrorLevels(
    @Body() dto: { errorBookIds: number[] },
    @CurrentUser() user: JwtUser,
  ) {
    return this.trainingService.bumpErrorLevels(dto.errorBookIds, user.sub);
  }

  /** 训练「提示」：题级 question_hints 缓存（命中直返，未命中 AI 生成 + 写回）。 */
  @Post('hint')
  async hint(@Body() dto: { questionId: number }, @CurrentUser() user: JwtUser) {
    return this.trainingService.getHint({ questionId: dto.questionId });
  }

  /** 专项练习 KP 树：平铺列表（树形组装放前端）。 */
  @Get('knowledge-points')
  async getKnowledgePoints(@Query('subjectId', ParseIntPipe) subjectId: number) {
    return this.trainingService.getKnowledgePoints(subjectId);
  }

  /** 专项练习开练：count 限 1-20 整数，type 限白名单六值（含 null），越界/非法 400。 */
  @Post('targeted/start')
  async startTargetedPractice(
    @Body() dto: { subjectId: number; kpId: number; type: string | null; count: number },
  ) {
    const { count } = dto;
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new BadRequestException('count 仅允许 1-20 的整数');
    }
    const type = dto.type ?? null;
    if (type !== null && !(TrainingController.TARGETED_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException(
        'type 仅允许 choice | fill_blank | true_false | short_answer | proof 或 null',
      );
    }
    return this.trainingService.startTargetedPractice({
      subjectId: dto.subjectId,
      kpId: dto.kpId,
      type,
      count,
    });
  }
}
