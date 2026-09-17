import { Module } from '@nestjs/common';
import { PointsController } from './points.controller.js';
import { ParentPointsController } from './parent-points.controller.js';
import { PointsService } from './points.service.js';
import { PointRulesService } from './point-rules.service.js';
import { RedemptionService } from './redemption.service.js';
import { PointRulesRepository } from '../../database/repositories/point-rules.repo.js';
import { PointLedgerRepository } from '../../database/repositories/point-ledger.repo.js';
import { StudentPointsRepository } from '../../database/repositories/student-points.repo.js';
import { TrainingSessionsRepository } from '../../database/repositories/training-sessions.repo.js';
import { RewardCatalogRepository } from '../../database/repositories/reward-catalog.repo.js';
import { PointRedemptionsRepository } from '../../database/repositories/point-redemptions.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import { ParentModule } from '../parent/parent.module.js';

/**
 * 闯关积分与段位模块（spec `2026-09-17-gamification-points-design.md`）。
 *
 * - `imports: [ParentModule]`：Task 8 的 `ParentPointsController` 要注入
 *   `ParentService.requireOwnedStudent` 做归属校验。
 * - `providers`：三个 service + **它们构造函数里注入的全部仓储**（逐个读构造签名列出，不靠猜）。
 *   少一个 Nest 就在启动时抛「Nest can't resolve dependencies」。`@Inject('DATABASE_POOL')`
 *   来自 `@Global()` 的 `DatabaseModule`，不需要在这里 import。
 * - `exports`：**必须有**。Task 9–12 的埋点从 `progress` / `practice` / `training` / `exams`
 *   模块注入 `PointsService`；Task 12 的 start 端点注入 `PointRulesService`。不导出它们解析不到。
 *
 * `RedemptionService` **不导出**：它只服务本模块的 controller（学生端只读 + Task 8 家长端兑换），
 * 其它模块不需要注入它。
 */
@Module({
  imports: [ParentModule],
  controllers: [PointsController, ParentPointsController],
  providers: [
    PointsService,
    PointRulesService,
    RedemptionService,
    PointRulesRepository,
    PointLedgerRepository,
    StudentPointsRepository,
    TrainingSessionsRepository,
    RewardCatalogRepository,
    PointRedemptionsRepository,
    ControlsRepository,
  ],
  exports: [PointsService, PointRulesService],
})
export class PointsModule {}
