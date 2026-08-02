import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AIService } from './ai.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { TutorDto } from './dto/tutor.dto.js';

@Controller('api/ai')
@UseGuards(JwtAuthGuard)
export class AIController {
  constructor(private readonly aiService: AIService) {}

  @Post('tutor')
  async tutor(@Body() dto: TutorDto, @CurrentUser() user: JwtUser) {
    return this.aiService.tutor(dto, user.sub);
  }
}
