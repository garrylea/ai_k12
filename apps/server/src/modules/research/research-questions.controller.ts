import {
  Body, Controller, Param, ParseIntPipe, Patch, UseGuards,
} from '@nestjs/common';
import {
  parseBody, ResearchQuestionsService, UpdateQuestionSchema,
} from './research-questions.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';

/** 题目五字段更正：仅 researcher 可访问，confirmedSource 由 zod 闸门强制。 */
@Controller('api/research/questions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('researcher')
export class ResearchQuestionsController {
  constructor(private readonly service: ResearchQuestionsService) {}

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: unknown, @CurrentUser() u: JwtUser) {
    return this.service.update(id, parseBody(UpdateQuestionSchema, body), u);
  }
}
