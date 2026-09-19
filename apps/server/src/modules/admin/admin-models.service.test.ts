import { describe, it, expect, vi } from 'vitest';
import { AdminModelsService, SCENES } from './admin-models.service';

const mk = (o: any = {}) => ({
  llmModelsRepo: {
    listAll: vi.fn().mockResolvedValue([]), listEnabled: vi.fn().mockResolvedValue([]),
    findByKey: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn(), setEnabled: vi.fn(),
  },
  llmRoutesRepo: { listAll: vi.fn().mockResolvedValue([]), replaceAll: vi.fn(), existsReferenceTo: vi.fn().mockResolvedValue(false) },
  registry: { reload: vi.fn().mockResolvedValue(undefined) },
  ...o,
});
const svc = (d: any) => new AdminModelsService(d.llmModelsRepo, d.llmRoutesRepo, d.registry);

const dbModel = (key: string) => ({ modelKey: key, name: key, providerType: 'kimi', modelId: key, baseUrl: 'https://x', apiKey: 'sk-secret123', contextWindow: 8, maxOutputTokens: 8, isEnabled: true, inputPricePer1k: 0, outputPricePer1k: 0 });

describe('AdminModelsService', () => {
  it('列表 apiKey 打码且不含明文', async () => {
    const d = mk({ llmModelsRepo: { ...mk().llmModelsRepo, listAll: vi.fn().mockResolvedValue([dbModel('m1')]) } });
    const list = await svc(d).list();
    expect(list[0].apiKeyMasked).toBe('sk-***123');
    expect(JSON.stringify(list)).not.toContain('sk-secret123');
  });

  it('新增重复 modelKey -> 1004', async () => {
    const d = mk({ llmModelsRepo: { ...mk().llmModelsRepo, findByKey: vi.fn().mockResolvedValue(dbModel('m1')) } });
    await expect(svc(d).create({ modelKey: 'm1', name: 'x', providerType: 'kimi', modelId: 'm', baseUrl: 'https://x', apiKey: 'sk-1' }))
      .rejects.toMatchObject({ response: { code: 1004 } });
  });

  it('新增非法 providerType -> 1001', async () => {
    await expect(svc(mk()).create({ modelKey: 'm2', name: 'x', providerType: 'bad', modelId: 'm', baseUrl: 'https://x', apiKey: 'sk-1' }))
      .rejects.toMatchObject({ response: { code: 1001 } });
  });

  it('停用被路由引用的模型 -> 1004', async () => {
    const d = mk({
      llmModelsRepo: { ...mk().llmModelsRepo, findByKey: vi.fn().mockResolvedValue(dbModel('m1')) },
      llmRoutesRepo: { ...mk().llmRoutesRepo, existsReferenceTo: vi.fn().mockResolvedValue(true) },
    });
    await expect(svc(d).setEnabled('m1', false)).rejects.toMatchObject({ response: { code: 1004 } });
  });

  it('保存路由引用不存在/停用的模型 -> 1004 拒整批且不写库', async () => {
    const d = mk({ llmModelsRepo: { ...mk().llmModelsRepo, listEnabled: vi.fn().mockResolvedValue([dbModel('m1')]) } });
    await expect(svc(d).saveRoutes([{ scene: 'tutoring', subject: 'math', primaryModelKey: 'ghost', fallbackModelKey: null }]))
      .rejects.toMatchObject({ response: { code: 1004 } });
    expect(d.llmRoutesRepo.replaceAll).not.toHaveBeenCalled();
  });

  it('合法保存 -> 事务替换 + registry.reload', async () => {
    const d = mk({ llmModelsRepo: { ...mk().llmModelsRepo, listEnabled: vi.fn().mockResolvedValue([dbModel('m1'), dbModel('m2')]) } });
    await svc(d).saveRoutes([{ scene: 'tutoring', subject: 'math', primaryModelKey: 'm1', fallbackModelKey: 'm2' }]);
    expect(d.llmRoutesRepo.replaceAll).toHaveBeenCalled();
    expect(d.registry.reload).toHaveBeenCalled();
  });

  it('更新模型（apiKey 空串不改）-> repo.update + reload', async () => {
    const d = mk({ llmModelsRepo: { ...mk().llmModelsRepo, findByKey: vi.fn().mockResolvedValue(dbModel('m1')) } });
    await svc(d).update('m1', { name: '新名', apiKey: '' });
    expect(d.llmModelsRepo.update).toHaveBeenCalledWith('m1', { name: '新名' });
    expect(d.registry.reload).toHaveBeenCalled();
  });

  it('更新/停用不存在的模型 -> 1002', async () => {
    await expect(svc(mk()).update('ghost', { name: 'x' })).rejects.toMatchObject({ response: { code: 1002 } });
    await expect(svc(mk()).setEnabled('ghost', false)).rejects.toMatchObject({ response: { code: 1002 } });
  });

  it('create 透传单价给 repo', async () => {
    const d = mk();
    await svc(d).create({
      modelKey: 'm9', name: 'M9', providerType: 'kimi', modelId: 'm9',
      baseUrl: 'https://x', apiKey: 'sk-1', inputPricePer1k: 0.007, outputPricePer1k: 0.028,
    });
    expect(d.llmModelsRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      inputPricePer1k: 0.007, outputPricePer1k: 0.028,
    }));
  });

  it('create 不给单价 -> 记 0（不是 undefined）', async () => {
    const d = mk();
    await svc(d).create({ modelKey: 'm8', name: 'M8', providerType: 'kimi', modelId: 'm8', baseUrl: 'https://x', apiKey: 'sk-1' });
    expect(d.llmModelsRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      inputPricePer1k: 0, outputPricePer1k: 0,
    }));
  });

  it('update 透传单价并触发 registry.reload', async () => {
    const d = mk({ llmModelsRepo: { ...mk().llmModelsRepo, findByKey: vi.fn().mockResolvedValue(dbModel('m1')) } });
    await svc(d).update('m1', { inputPricePer1k: 0.02 });
    expect(d.llmModelsRepo.update).toHaveBeenCalledWith('m1', { inputPricePer1k: 0.02 });
    expect(d.registry.reload).toHaveBeenCalled();
  });
});

describe('SCENES 白名单漂移守卫', () => {
  it('YAML routes 里每个场景都必须出现在 SCENES 中', async () => {
    // 漏一个的后果是「后台存了路由但下拉里选不到」（用却不显）。saveRoutes 不校验 scene，
    // 所以漏项不报错、只悄悄少一个选项——interpretation_judge 曾漏过一段时间。
    // Scene 是 TS 类型、运行时枚举不出来，但 YAML 的路由键是运行时真值，足够当哨兵。
    const { routeConfig } = await import('../../ai-core/config.js');
    const yamlScenes = Object.keys(routeConfig.routes);
    const missing = yamlScenes.filter((s) => !(SCENES as readonly string[]).includes(s));
    expect(missing).toEqual([]);
  });

  it('背词判题场景已在白名单内（新场景接线别漏这一步）', () => {
    expect(SCENES as readonly string[]).toContain('english_word_judge');
    expect(SCENES as readonly string[]).toContain('interpretation_judge');
  });
});
