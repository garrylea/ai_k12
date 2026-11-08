import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { FreeformRecognizeService } from './freeform-recognize.service.js';
import { FreeformJudgeService } from './freeform-judge.service.js';
import type { FreeformRecognizeDto } from './dto/freeform.dto.js';

/**
 * 自由输入做题（任务书 Task 7）。
 *
 * 目前只有第一步：题图/文字 → 候选题。`judge` / `judge/stream` 在 Task 10 加，
 * `FreeformJudgeService` 因此先以占位实现注入，仅为模块可编译。
 * 归属一律取 JWT 的 `sub`，不接受 body 里的 studentId。
 */
@Controller('api/freeform')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class FreeformController {
  constructor(
    private readonly recognizeService: FreeformRecognizeService,
    // Task 10 才用到；先注入占位实现，避免模块装配时缺 provider。
    private readonly judgeService: FreeformJudgeService,
  ) {}

  /** 题图/文字 → 候选题。张数上限在此拦，图片合法性/文字长度由 service 校验。 */
  @Post('recognize')
  async recognize(@Body() dto: FreeformRecognizeDto, @CurrentUser() user: JwtUser) {
    const fileIds = dto?.fileIds ?? [];
    if (!Array.isArray(fileIds)) {
      throw new BadRequestException({ code: 1001, message: 'fileIds 必须是数组' });
    }
    if (fileIds.length > 6) {
      throw new BadRequestException({ code: 1001, message: '最多 6 张题图' });
    }
    return this.recognizeService.recognize({ text: dto?.text, fileIds }, user.sub);
  }
}
