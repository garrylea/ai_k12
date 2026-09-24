import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { LearningSessionsService } from './learning-sessions.service.js';
import type { StudentSessionView } from './dto/device-control.dto.js';

/**
 * 学生端学习会话（spec §5.1/§5.2）。
 *
 * 不手工包 `{code, message, data}` —— 全局 `ResponseInterceptor` 统一包。
 */
@Controller('api/student/learning-sessions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class DeviceControlController {
  constructor(private readonly sessions: LearningSessionsService) {}

  /**
   * 取或建本次学习会话。**显式 200**（本仓第一个 `@HttpCode` 覆盖）：
   * 该端点是幂等的「取或建」，`@Post` 默认的 201 会误导调用方「每次都在创建」。
   */
  @Post()
  @HttpCode(200)
  async openOrGet(@CurrentUser() user: JwtUser): Promise<StudentSessionView> {
    return this.sessions.openOrGet(user.sub);
  }
}
