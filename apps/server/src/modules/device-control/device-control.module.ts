import { Module } from '@nestjs/common';
import { DeviceControlController } from './device-control.controller.js';
import { LearningSessionsService } from './learning-sessions.service.js';
import { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';

/**
 * PC App 学习管控（spec `2026-09-23-pc-app-study-lockdown-design.md`）。
 *
 * `providers` 必须**逐个列出 service 构造函数里注入的全部仓储**，少一个 Nest 启动就抛
 * 「can't resolve dependencies」；`@Inject('DATABASE_POOL')` 来自 `@Global()` 的
 * `DatabaseModule`，不需要在这里 import。
 *
 * `ControlsRepository` 在这里**再列一次**（`ParentInsightsModule` 已列）：仓储是无状态的
 * （只握 pool），多一个实例无害；`AnalyticsModule` 也是这么做的，属既有先例。
 */
@Module({
  controllers: [DeviceControlController],
  providers: [LearningSessionsService, LearningSessionsRepository, ControlsRepository],
})
export class DeviceControlModule {}
