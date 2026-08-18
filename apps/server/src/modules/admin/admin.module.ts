import { Module } from '@nestjs/common';
import { LlmModelsRepository } from '../../database/repositories/llm-models.repo.js';
import { LlmRoutesRepository } from '../../database/repositories/llm-routes.repo.js';
import { ModelConfigRegistry, getModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';
import { CommonModule } from '../../common/common.module.js';
import { AdminController } from './admin.controller.js';
import { AdminModelsService } from './admin-models.service.js';
import { AdminAccountsService } from './admin-accounts.service.js';

/** registry 复用 ConfigModule 设置的全局单例（带 repo、启动时已 reload），不另建实例。 */
@Module({
  imports: [CommonModule],
  controllers: [AdminController],
  providers: [
    LlmModelsRepository,
    LlmRoutesRepository,
    { provide: ModelConfigRegistry, useFactory: () => getModelConfigRegistry() ?? new ModelConfigRegistry() },
    AdminModelsService,
    AdminAccountsService,
  ],
})
export class AdminModule {}
