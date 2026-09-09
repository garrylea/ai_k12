import { BadRequestException, Body, Controller, Delete, Get, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { PracticeService } from './practice.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { JudgePracticeDto } from './dto/judge-practice.dto.js';
import type { HintPracticeDto } from './dto/hint-practice.dto.js';
import type { DiscussPracticeDto } from './dto/discuss-practice.dto.js';
import type { DiscussCardPracticeDto } from './dto/discuss-card-practice.dto.js';

@Controller('api/practice')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class PracticeController {
  constructor(private readonly practiceService: PracticeService) {}

  @Post('judge')
  async judge(@Body() dto: JudgePracticeDto, @CurrentUser() user: JwtUser) {
    return this.practiceService.judge({
      studentId: user.sub,
      subjectId: dto.subjectId,
      cardId: dto.cardId,
      lessonId: dto.lessonId,
      questionN: dto.questionN,
      questionText: dto.questionText,
      studentAnswer: dto.studentAnswer,
    });
  }

  /** 课堂练习主观题自评（self_assess 模式）：补写 practice_results + 留痕 + 错题本写入/清零。 */
  @Post('self-assess')
  async selfAssess(@Body() dto: {
    cardId: number; lessonId: number; subjectId: number;
    questionN: string; questionText: string; questionId: number | null;
    studentAnswer: string; assessment: 'correct' | 'incorrect';
  }, @CurrentUser() user: JwtUser) {
    if (!Number.isInteger(dto.cardId) || dto.cardId < 1 ||
        !Number.isInteger(dto.lessonId) || dto.lessonId < 1 ||
        !Number.isInteger(dto.subjectId) || dto.subjectId < 1) {
      throw new BadRequestException('cardId/lessonId/subjectId 须为正整数');
    }
    if (!dto.questionN || !dto.questionText) {
      throw new BadRequestException('questionN 与 questionText 必填');
    }
    if (dto.questionId != null && (!Number.isInteger(dto.questionId) || dto.questionId < 1)) {
      throw new BadRequestException('questionId 须为正整数或 null');
    }
    if (dto.assessment !== 'correct' && dto.assessment !== 'incorrect') {
      throw new BadRequestException('assessment 仅允许 correct | incorrect');
    }
    await this.practiceService.selfAssess({
      studentId: user.sub,
      cardId: dto.cardId,
      lessonId: dto.lessonId,
      subjectId: dto.subjectId,
      questionN: dto.questionN,
      questionText: dto.questionText,
      questionId: dto.questionId ?? null,
      studentAnswer: dto.studentAnswer ?? '',
      assessment: dto.assessment,
    });
    return null; // ResponseInterceptor 包成 { code: 0, data: null }
  }

  @Post('hint')
  async hint(@Body() dto: HintPracticeDto, @CurrentUser() user: JwtUser) {
    return this.practiceService.getHint({
      studentId: user.sub,
      subjectId: dto.subjectId,
      cardId: dto.cardId,
      lessonId: dto.lessonId,
      questionText: dto.questionText,
    });
  }

  @Post('discuss')
  async discuss(@Body() dto: DiscussPracticeDto, @CurrentUser() user: JwtUser) {
    return this.practiceService.startDiscuss({
      studentId: user.sub,
      subjectId: dto.subjectId,
      cardId: dto.cardId,
      lessonId: dto.lessonId,
      questionText: dto.questionText,
    });
  }

  @Post('discuss-card')
  async discussCard(@Body() dto: DiscussCardPracticeDto, @CurrentUser() user: JwtUser) {
    return this.practiceService.startCardDiscuss({
      studentId: user.sub,
      subjectId: dto.subjectId,
      cardId: dto.cardId,
      lessonId: dto.lessonId,
    });
  }

  @Get('results')
  async getResults(@Query('cardId', ParseIntPipe) cardId: number, @CurrentUser() user: JwtUser) {
    return this.practiceService.getResults(user.sub, cardId);
  }

  @Delete('results')
  async resetResults(
    @CurrentUser() user: JwtUser,
    @Query('cardId') cardIdStr?: string,
    @Query('lessonId') lessonIdStr?: string,
  ) {
    if (cardIdStr !== undefined && lessonIdStr !== undefined) {
      throw new BadRequestException('cardId 与 lessonId 不可同时指定');
    }
    if (cardIdStr !== undefined) {
      const cardId = parseInt(cardIdStr, 10);
      if (Number.isNaN(cardId)) throw new BadRequestException('cardId 非法');
      return this.practiceService.resetCard(user.sub, cardId);
    }
    if (lessonIdStr !== undefined) {
      const lessonId = parseInt(lessonIdStr, 10);
      if (Number.isNaN(lessonId)) throw new BadRequestException('lessonId 非法');
      return this.practiceService.resetLesson(user.sub, lessonId);
    }
    throw new BadRequestException('须指定 cardId 或 lessonId');
  }

  @Get('uncleared-errors')
  async unclearedErrors(
    @Query('subjectId', ParseIntPipe) subjectId: number,
    @Query('lessonId') lessonIdStr: string | undefined,
    @CurrentUser() user: JwtUser,
  ) {
    // lessonId 可选：传入时只返回「当前课之前」的错题（本课刚产生的错题不触发清零门禁）
    const lessonId = lessonIdStr !== undefined && lessonIdStr !== ''
      ? parseInt(lessonIdStr, 10)
      : null;
    if (lessonIdStr !== undefined && lessonIdStr !== '' && Number.isNaN(lessonId)) {
      throw new BadRequestException('lessonId 非法');
    }
    return this.practiceService.getUnclearedErrorDetails(user.sub, subjectId, lessonId);
  }

  @Post('bump-error-levels')
  async bumpErrorLevels(
    @Body() dto: { errorBookIds: number[] },
    @CurrentUser() user: JwtUser,
  ) {
    return this.practiceService.bumpErrorLevels(dto.errorBookIds, user.sub);
  }
}
