import { describe, it, expect, vi } from 'vitest';
import { LlmModelsRepository } from './llm-models.repo';
import { encryptApiKey } from '../../common/utils/api-key-crypto';

/** 模拟 mysql2 pool 的双返回形状：SELECT -> [rows, fields] */
const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockImplementation((sql: string) => {
    if (/^\s*(INSERT|UPDATE)/i.test(sql)) return Promise.resolve([{ affectedRows: 1 }, []]);
    return Promise.resolve([rows, []]);
  }),
  query: vi.fn().mockResolvedValue([rows, []]),
});

const dbRow = () => ({
  id: 1, model_key: 'kimi', name: 'Kimi', provider_type: 'kimi', model_id: 'kimi-latest',
  base_url: 'https://x', api_key: encryptApiKey('sk-test'), context_window: 131072,
  max_output_tokens: 16384, is_enabled: 1,
  input_price_per_1k: '0.012000', output_price_per_1k: '0.028000',
});

describe('LlmModelsRepository 单价映射', () => {
  it('mapRow 把 DECIMAL 字符串转成 number（mysql2 对 DECIMAL 返回字符串）', async () => {
    const repo = new LlmModelsRepository(mockPool([dbRow()]) as any);
    const [m] = await repo.listAll();
    expect(m.inputPricePer1k).toBeCloseTo(0.012, 6);
    expect(m.outputPricePer1k).toBeCloseTo(0.028, 6);
    expect(typeof m.inputPricePer1k).toBe('number');
  });

  it('create 落单价，缺省写 0', async () => {
    const pool = mockPool();
    const repo = new LlmModelsRepository(pool as any);
    await repo.create({
      modelKey: 'm1', name: 'M1', providerType: 'kimi', modelId: 'm1',
      baseUrl: 'https://x', apiKey: 'sk-1', contextWindow: 8, maxOutputTokens: 8,
      inputPricePer1k: 0.007, outputPricePer1k: 0.028,
    });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('input_price_per_1k');
    expect(sql).toContain('output_price_per_1k');
    expect(params).toContain(0.007);
    expect(params).toContain(0.028);
  });

  it('update 只写显式传入的单价（未传则不动该列）', async () => {
    const pool = mockPool();
    const repo = new LlmModelsRepository(pool as any);
    await repo.update('m1', { inputPricePer1k: 0.02 });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('input_price_per_1k = ?');
    expect(sql).not.toContain('output_price_per_1k');
    expect(params).toEqual([0.02, 'm1']);
  });
});
