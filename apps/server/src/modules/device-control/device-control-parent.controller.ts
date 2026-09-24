import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { ParentService } from '../parent/parent.service.js';
import { parsePositiveInt } from '../points/pagination.util.js';
import { DeviceCommandsService } from './device-commands.service.js';
import { LearningSessionLogService } from './learning-session-log.service.js';
import type { IssuedCommandView, ParentSessionPage } from './dto/device-control.dto.js';

/** 本期唯一命令（与 `DeviceCommandsRepository.DEVICE_COMMANDS` 同步；新增命令两处都要改）。 */
const IssueCommandSchema = z.object({
  command: z.enum(['unlock']),
});

/** 「进出时间」的窗口与条数默认值/上界（spec §5.5）。 */
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * 家长端设备命令（spec §5.4/§5.5）。
 *
 * 与 `ParentInsightsController` **共用 `api/parent` 前缀**（Nest 允许多个 controller 共享前缀，
 * `ParentPointsController` 是先例），但**路径不许撞车**——撞了会静默覆盖。
 */
@Controller('api/parent')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('parent')
export class DeviceControlParentController {
  constructor(
    private readonly parentService: ParentService,
    private readonly commands: DeviceCommandsService,
    private readonly logs: LearningSessionLogService,
  ) {}

  /** 归属校验必须是**第一行**，与本仓其余家长端端点一致。 */
  @Post('students/:studentId/device-commands')
  async issue(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Body() body: unknown,
  ): Promise<IssuedCommandView> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    const parsed = IssueCommandSchema.safeParse(body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
        .join('; ');
      throw new BadRequestException({ code: 1001, message: `入参校验失败：${detail}` });
    }
    return this.commands.issue(studentId, user.sub, parsed.data.command);
  }

  /**
   * 进出时间列表（spec §5.5）。`days` 缺省 7（1..90）、`limit` 缺省 50（1..100）；
   * **越界 400/1001，不静默钳制**（本仓全局纪律）。
   * `parsePositiveInt` 复用 `parent-insights.controller.ts` 里那一个，**勿新写**。
   */
  @Get('students/:studentId/learning-sessions')
  async listSessions(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ): Promise<ParentSessionPage> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.logs.list(
      studentId,
      parsePositiveInt(days, 'days', DEFAULT_DAYS, MAX_DAYS),
      parsePositiveInt(limit, 'limit', DEFAULT_LIMIT, MAX_LIMIT),
    );
  }
}
