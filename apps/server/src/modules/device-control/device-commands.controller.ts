import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { LearningSessionsService } from './learning-sessions.service.js';
import type { PollView } from './dto/device-control.dto.js';

/** 学生端命令轮询（spec §5.3）。路径是 `api/student/device-commands`，故独立成类。 */
@Controller('api/student/device-commands')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class DeviceCommandsController {
  constructor(private readonly sessions: LearningSessionsService) {}

  /** 轮询（兼心跳）。空结果是正常态：`{ commands: [], lock: null }`。 */
  @Get()
  async poll(@CurrentUser() user: JwtUser): Promise<PollView> {
    return this.sessions.poll(user.sub);
  }
}
