import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { RemediationService } from './remediation.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { GenerateRemediationDto, RemediationSelfAssessDto, SubmitRemediationAnswerDto } from './dto/remediation.dto.js';

/** 错题补偿套题（相似题专项练习，2026-09-21）。
 *  设计：docs/superpowers/specs/2026-09-21-remediation-set-design.md */
@Controller('api/training/remediation')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class RemediationController {
  constructor(private readonly remediationService: RemediationService) {}

  /** 学生同意后生成套题：同步建组 + 题库抽题，AI 补题后台跑（201）。 */
  @Post('generate')
  async generate(@Body() dto: GenerateRemediationDto, @CurrentUser() user: JwtUser) {
    if (dto.source !== 'exam' && dto.source !== 'targeted') {
      throw new BadRequestException('source 仅允许 exam | targeted');
    }
    if (!Number.isInteger(dto.sessionId) || dto.sessionId < 1) {
      throw new BadRequestException('sessionId 非法');
    }
    if (dto.source === 'targeted') {
      if (!Array.isArray(dto.wrongQuestionIds) || dto.wrongQuestionIds.length === 0) {
        throw new BadRequestException('targeted 来源必须携带 wrongQuestionIds');
      }
      if (dto.wrongQuestionIds.length > 50) throw new BadRequestException('wrongQuestionIds 最多 50 题');
      if (!dto.wrongQuestionIds.every((id) => Number.isInteger(id) && id >= 1)) {
        throw new BadRequestException('wrongQuestionIds 含非法题号');
      }
    }
    return this.remediationService.generate(user.sub, dto);
  }

  @Get('me')
  async me(@CurrentUser() user: JwtUser) {
    return this.remediationService.getOverview(user.sub);
  }

  @Get('questions')
  async questions(@CurrentUser() user: JwtUser) {
    return this.remediationService.listQuestions(user.sub);
  }

  @Post('answers')
  async answer(@Body() dto: SubmitRemediationAnswerDto, @CurrentUser() user: JwtUser) {
    if (!Number.isInteger(dto.questionId) || dto.questionId < 1) {
      throw new BadRequestException('questionId 非法');
    }
    if (typeof dto.studentAnswer !== 'string') throw new BadRequestException('studentAnswer 非法');
    return this.remediationService.submitAnswer(user.sub, dto);
  }

  @Post('self-assess')
  async selfAssess(@Body() dto: RemediationSelfAssessDto, @CurrentUser() user: JwtUser) {
    if (!Number.isInteger(dto.questionId) || dto.questionId < 1) {
      throw new BadRequestException('questionId 非法');
    }
    if (dto.assessment !== 'correct' && dto.assessment !== 'incorrect') {
      throw new BadRequestException('assessment 仅允许 correct | incorrect');
    }
    return this.remediationService.selfAssess(user.sub, dto);
  }
}
