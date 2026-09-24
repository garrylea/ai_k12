import { Module } from '@nestjs/common';
import { DeviceControlController } from './device-control.controller.js';
import { DeviceCommandsController } from './device-commands.controller.js';
import { DeviceControlParentController } from './device-control-parent.controller.js';
import { LearningSessionsService } from './learning-sessions.service.js';
import { DeviceCommandsService } from './device-commands.service.js';
import { LearningSessionLogService } from './learning-session-log.service.js';
import { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import { DeviceCommandsRepository } from '../../database/repositories/device-commands.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import { ParentModule } from '../parent/parent.module.js';

/**
 * PC App 学习管控（spec `2026-09-23-pc-app-study-lockdown-design.md`）。
 *
 * - `imports: [ParentModule]` —— 家长端 handler 用 `ParentService.requireOwnedStudent`
 *   做归属校验（`ParentModule` 已 `exports: [ParentService]`）。
 * - `providers` 必须**逐个列出 service 构造函数里注入的全部仓储**；`@Inject('DATABASE_POOL')`
 *   来自 `@Global()` 的 `DatabaseModule`，不需要 import。
 * - `ControlsRepository` 在这里**再列一次**（`ParentInsightsModule` 已列）：仓储无状态
 *   （只握 pool），多一个实例无害；`AnalyticsModule` 同样做法。
 */
@Module({
  imports: [ParentModule],
  controllers: [DeviceControlController, DeviceCommandsController, DeviceControlParentController],
  providers: [
    LearningSessionsService,
    DeviceCommandsService,
    LearningSessionLogService,
    LearningSessionsRepository,
    DeviceCommandsRepository,
    ControlsRepository,
  ],
})
export class DeviceControlModule {}
