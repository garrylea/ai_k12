import { describe, it, expect, vi } from 'vitest';
import { ModelConfigRegistry } from './model-config-registry.js';
import { routeConfig } from '../config.js';

const mkDb = (models: any[], routes: any[]) => ({
  llmModelsRepo: { listEnabled: vi.fn().mockResolvedValue(models) },
  llmRoutesRepo: { listAll: vi.fn().mockResolvedValue(routes) },
});

const model = (key: string, apiKey = 'sk-x') => ({
  modelKey: key, name: key, providerType: 'openai_compatible', modelId: key,
  baseUrl: 'https://x.example', apiKey, contextWindow: 8192, maxOutputTokens: 4096, isEnabled: true,
});

describe('ModelConfigRegistry', () => {
  it('DB 空表 -> 回落 YAML 快照', async () => {
    const reg = new ModelConfigRegistry(mkDb([], []) as any);
    await reg.reload();
    expect(reg.getSnapshot().models).toEqual(routeConfig.models);
    expect(reg.getSnapshot().routes).toEqual(routeConfig.routes);
  });

  it('DB 查询抛错 -> 回落 YAML', async () => {
    const db = mkDb([], []);
    db.llmModelsRepo.listEnabled.mockRejectedValue(new Error('db down'));
    const reg = new ModelConfigRegistry(db as any);
    await reg.reload();
    expect(reg.getSnapshot().models).toEqual(routeConfig.models);
  });

  it('DB 有数据 -> 快照来自 DB 且带 apiKey', async () => {
    const reg = new ModelConfigRegistry(mkDb([model('m1', 'sk-secret')], [
      { scene: 'tutoring', subject: 'math', primaryModelKey: 'm1', fallbackModelKey: null },
    ]) as any);
    await reg.reload();
    const snap = reg.getSnapshot();
    expect(snap.models['m1'].apiKey).toBe('sk-secret');
    expect(snap.routes['tutoring'][0].primary).toBe('m1');
  });

  it('reload 失败后旧快照保留（不清空）', async () => {
    const db = mkDb([model('m1')], []);
    const reg = new ModelConfigRegistry(db as any);
    await reg.reload();
    db.llmModelsRepo.listEnabled.mockRejectedValue(new Error('down'));
    await reg.reload();
    expect(reg.getSnapshot().models['m1']).toBeDefined();
  });
});
