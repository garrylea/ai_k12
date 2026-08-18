import { Module, OnModuleInit } from '@nestjs/common';
import { LlmModelsRepository } from '../../database/repositories/llm-models.repo.js';
import { LlmRoutesRepository } from '../../database/repositories/llm-routes.repo.js';
import { ModelConfigRegistry, setModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';

/** 启动时创建全局 ModelConfigRegistry 单例并首次 reload（DB 空或失败回落 YAML，不阻塞启动）。 */
@Module({
  providers: [LlmModelsRepository, LlmRoutesRepository],
})
export class ConfigModule implements OnModuleInit {
  constructor(
    private llmModelsRepo: LlmModelsRepository,
    private llmRoutesRepo: LlmRoutesRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const reg = new ModelConfigRegistry({
      llmModelsRepo: this.llmModelsRepo,
      llmRoutesRepo: this.llmRoutesRepo,
    });
    setModelConfigRegistry(reg);
    await reg.reload().catch(() => undefined);
  }
}
