import { Module } from '@nestjs/common';
import { LlmModelsRepository } from '../../database/repositories/llm-models.repo.js';
import { LlmRoutesRepository } from '../../database/repositories/llm-routes.repo.js';
import { ParentMessagesRepository } from '../../database/repositories/parent-messages.repo.js';
import { AdminChatRepository } from '../../database/repositories/admin-chat.repo.js';
import { AdminNotificationsRepository } from '../../database/repositories/admin-notifications.repo.js';
import { AdminsRepository } from '../../database/repositories/admins.repo.js';
import { ModelConfigRegistry, getModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';
import { ModelClient } from '../../ai-core/infra/model-client/index.js';
import { CommonModule } from '../../common/common.module.js';
import { SafetyAlertsModule } from '../safety/safety-alerts.module.js';
import { AdminController } from './admin.controller.js';
import { AdminModelsService } from './admin-models.service.js';
import { AdminAccountsService } from './admin-accounts.service.js';
import { AdminMessagesService } from './admin-messages.service.js';
import { AdminNotificationsService } from './admin-notifications.service.js';
import { AdminChatService } from './admin-chat.service.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
import { AdminAlertsService } from './admin-alerts.service.js';

/** registry 复用 ConfigModule 设置的全局单例（带 repo、启动时已 reload），不另建实例。 */
@Module({
  // `SafetyAlertsModule` 只 import 不重复 provide：它的注释明确警告重复 provide
  // `SafetyAlertsRepository` 会分裂实例、破坏预警去重语义。这里只要它导出的仓储。
  imports: [CommonModule, SafetyAlertsModule],
  controllers: [AdminController],
  providers: [
    LlmModelsRepository,
    LlmRoutesRepository,
    ParentMessagesRepository,
    AdminChatRepository,
    AdminNotificationsRepository,
    AdminsRepository,
    { provide: ModelConfigRegistry, useFactory: () => getModelConfigRegistry() ?? new ModelConfigRegistry() },
    { provide: ModelClient, useFactory: () => new ModelClient() },
    AdminModelsService,
    AdminAccountsService,
    AdminMessagesService,
    AdminNotificationsService,
    AdminChatService,
    AdminDashboardService,
    AdminAlertsService,
  ],
  exports: [AdminMessagesService, AdminNotificationsService, ParentMessagesRepository],
})
export class AdminModule {}
