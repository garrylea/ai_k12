import { BadRequestException, Body, Controller, Delete, Get, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { PracticeService } from './practice.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { JudgePracticeDto } from './dto/judge-practice.dto.js';
import type { HintPracticeDto } from './dto/hint-practice.dto.js';
import type { DiscussPracticeDto } from './dto/discuss-practice.dto.js';
import type { DiscussCardPracticeDto } from './dto/discuss-card-practice.dto.js';

@Controller('api/practice')
@UseGuards(JwtAuthGuard)
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

  @Get('previous-errors')
  async previousErrors(
    @Query('lessonId', ParseIntPipe) lessonId: number,
    @CurrentUser() user: JwtUser,
  ) {
    return this.practiceService.countUnclearedErrorsFromPreviousLesson(user.sub, lessonId);
  }
}
