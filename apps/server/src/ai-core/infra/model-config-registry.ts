import { routeConfig } from '../config.js';
import type { ModelConfig, Provider } from '../types.js';
import type { LlmModelsRepository } from '../../database/repositories/llm-models.repo.js';
import type { LlmRoutesRepository } from '../../database/repositories/llm-routes.repo.js';

interface RouteRule {
  subject: string;
  difficulty?: number[];
  primary: string;
  fallback?: string | null;
}

export interface RegistrySnapshot {
  models: Record<string, ModelConfig & { apiKey: string }>;
  routes: Record<string, RouteRule[]>;
  default: { primary: string; fallback: string };
}

const yamlSnapshot = (): RegistrySnapshot => ({
  models: routeConfig.models as Record<string, ModelConfig & { apiKey: string }>,
  routes: routeConfig.routes as Record<string, RouteRule[]>,
  default: routeConfig.default,
});

function mapProviderType(providerType: string): Provider {
  if (providerType === 'openai_compatible') return 'kimi';
  return providerType as Provider;
}

/**
 * 模型配置运行时真源：内存快照 + 按需 reload。DB 空/失败回落 YAML（seed 前系统照常跑）。
 * reload 失败时保留旧快照（不清空），管理员保存后调用方 reload 即生效。
 */
export interface RegistryDeps {
  llmModelsRepo: Pick<LlmModelsRepository, 'listEnabled'>;
  llmRoutesRepo: Pick<LlmRoutesRepository, 'listAll'>;
}

export class ModelConfigRegistry {
  private snapshot: RegistrySnapshot = yamlSnapshot();

  constructor(private deps?: RegistryDeps) {}

  getSnapshot(): RegistrySnapshot {
    return this.snapshot;
  }

  async reload(): Promise<void> {
    if (!this.deps) return;
    const { llmModelsRepo, llmRoutesRepo } = this.deps;
    try {
      const [models, routes] = await Promise.all([
        llmModelsRepo.listEnabled(),
        llmRoutesRepo.listAll(),
      ]);
      if (models.length === 0) return; // 空=未 seed，回落 YAML
      const next: RegistrySnapshot = {
        models: {},
        routes: {},
        default: this.snapshot.default,
      };
      for (const m of models) {
        next.models[m.modelKey] = {
          provider: mapProviderType(m.providerType),
          modelId: m.modelId,
          baseUrl: m.baseUrl,
          apiKey: m.apiKey,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          costPer1K: { input: 0, output: 0 },
          supportsStreaming: true,
        };
      }
      for (const r of routes) {
        (next.routes[r.scene] ??= []).push({
          subject: r.subject,
          primary: r.primaryModelKey,
          fallback: r.fallbackModelKey,
        });
      }
      this.snapshot = next;
    } catch {
      // DB 不可用：保留当前快照（初始为 YAML）
    }
  }
}
