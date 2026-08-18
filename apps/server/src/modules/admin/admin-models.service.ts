import { Injectable, ConflictException, NotFoundException, Inject } from '@nestjs/common';
import { LlmModelsRepository } from '../../database/repositories/llm-models.repo.js';
import { LlmRoutesRepository } from '../../database/repositories/llm-routes.repo.js';
import type { LlmRoute } from '../../database/repositories/llm-routes.repo.js';
import { ModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';

export const PROVIDER_TYPES = ['kimi', 'qwen', 'deepseek', 'gemini', 'openai_compatible'] as const;
export const SCENES = ['tutoring', 'grading', 'judgment', 'hint', 'explanation', 'variation', 'structuring', 'transcribe'] as const;

@Injectable()
export class AdminModelsService {
  constructor(
    private llmModelsRepo: LlmModelsRepository,
    private llmRoutesRepo: LlmRoutesRepository,
    // Pick<...> 类型注解使 design:paramtypes 序列化为 Object，需显式 token 注入
    @Inject(ModelConfigRegistry) private registry: Pick<ModelConfigRegistry, 'reload'>,
  ) {}

  async list() {
    const models = await this.llmModelsRepo.listAll();
    return models.map((m) => {
      const { apiKey: _k, ...rest } = m;
      return { ...rest, apiKeyMasked: m.apiKey.length > 8 ? `${m.apiKey.slice(0, 3)}***${m.apiKey.slice(-3)}` : '***' };
    });
  }

  async create(dto: { modelKey: string; name: string; providerType: string; modelId: string; baseUrl: string; apiKey: string; contextWindow?: number; maxOutputTokens?: number }) {
    if (!(PROVIDER_TYPES as readonly string[]).includes(dto.providerType)) {
      throw new ConflictException({ code: 1001, message: '供应商类型不合法' });
    }
    if (await this.llmModelsRepo.findByKey(dto.modelKey)) {
      throw new ConflictException({ code: 1004, message: 'model_key 已存在' });
    }
    await this.llmModelsRepo.create({
      modelKey: dto.modelKey, name: dto.name, providerType: dto.providerType, modelId: dto.modelId,
      baseUrl: dto.baseUrl, apiKey: dto.apiKey,
      contextWindow: dto.contextWindow ?? 131072, maxOutputTokens: dto.maxOutputTokens ?? 16384,
    });
    await this.registry.reload();
  }

  async update(modelKey: string, dto: Partial<{ name: string; providerType: string; modelId: string; baseUrl: string; apiKey: string; contextWindow: number; maxOutputTokens: number }>) {
    if (!(await this.llmModelsRepo.findByKey(modelKey))) {
      throw new NotFoundException({ code: 1002, message: '模型不存在' });
    }
    const { apiKey, ...rest } = dto;
    const patch = apiKey === '' ? rest : dto; // 空串=不改 key
    await this.llmModelsRepo.update(modelKey, patch);
    await this.registry.reload();
  }

  async setEnabled(modelKey: string, enabled: boolean) {
    if (!(await this.llmModelsRepo.findByKey(modelKey))) {
      throw new NotFoundException({ code: 1002, message: '模型不存在' });
    }
    if (!enabled && (await this.llmRoutesRepo.existsReferenceTo(modelKey))) {
      throw new ConflictException({ code: 1004, message: '该模型被路由表引用，先改路由再停用' });
    }
    await this.llmModelsRepo.setEnabled(modelKey, enabled);
    await this.registry.reload();
  }

  async listRoutes() {
    return { routes: await this.llmRoutesRepo.listAll(), scenes: SCENES, providerTypes: PROVIDER_TYPES };
  }

  async saveRoutes(routes: LlmRoute[]) {
    const enabled = await this.llmModelsRepo.listEnabled();
    const ok = new Set(enabled.map((m) => m.modelKey));
    for (const r of routes) {
      if (!ok.has(r.primaryModelKey) || (r.fallbackModelKey && !ok.has(r.fallbackModelKey))) {
        throw new ConflictException({ code: 1004, message: `路由引用了不存在或停用的模型: ${r.primaryModelKey}/${r.fallbackModelKey ?? '-'}` });
      }
    }
    await this.llmRoutesRepo.replaceAll(routes);
    await this.registry.reload();
  }
}
