import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { ParentService } from '../parent/parent.service.js';
import { DeviceCommandsService } from './device-commands.service.js';
import type { IssuedCommandView } from './dto/device-control.dto.js';

/** 本期唯一命令（与 `DeviceCommandsRepository.DEVICE_COMMANDS` 同步；新增命令两处都要改）。 */
const IssueCommandSchema = z.object({
  command: z.enum(['unlock']),
});

/**
 * 家长端设备命令（spec §5.4）。
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
}
