import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { PracticeService } from './practice.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { JudgePracticeDto } from './dto/judge-practice.dto.js';
import type { HintPracticeDto } from './dto/hint-practice.dto.js';

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
}
