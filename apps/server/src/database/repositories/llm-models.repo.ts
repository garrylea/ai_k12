import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { encryptApiKey, decryptApiKey } from '../../common/utils/api-key-crypto.js';

export interface LlmModelRow extends RowDataPacket {
  id: number; model_key: string; name: string; provider_type: string;
  model_id: string; base_url: string; api_key: string;
  context_window: number; max_output_tokens: number; is_enabled: number;
  // mysql2 对 DECIMAL 返回字符串，mapRow 负责转 number
  input_price_per_1k: string | number; output_price_per_1k: string | number;
}

export interface LlmModel {
  modelKey: string; name: string; providerType: string; modelId: string;
  baseUrl: string; apiKey: string; contextWindow: number; maxOutputTokens: number; isEnabled: boolean;
  /** 每 1K 输入 token 单价，与 model-routes.yaml 的 costPer1K.input 同单位 */
  inputPricePer1k: number;
  /** 每 1K 输出 token 单价 */
  outputPricePer1k: number;
}

@Injectable()
export class LlmModelsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async listAll(): Promise<LlmModel[]> {
    const [rows] = await this.pool.execute<LlmModelRow[]>('SELECT * FROM llm_models ORDER BY id');
    return rows.map((r) => this.mapRow(r));
  }

  async listEnabled(): Promise<LlmModel[]> {
    const [rows] = await this.pool.execute<LlmModelRow[]>(
      'SELECT * FROM llm_models WHERE is_enabled = 1 ORDER BY id');
    return rows.map((r) => this.mapRow(r));
  }

  async findByKey(modelKey: string): Promise<LlmModel | null> {
    const [rows] = await this.pool.execute<LlmModelRow[]>(
      'SELECT * FROM llm_models WHERE model_key = ?', [modelKey]);
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async create(data: Omit<LlmModel, 'isEnabled'> & { isEnabled?: boolean }): Promise<void> {
    await this.pool.execute(
      `INSERT INTO llm_models (model_key, name, provider_type, model_id, base_url, api_key, context_window, max_output_tokens, input_price_per_1k, output_price_per_1k, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.modelKey, data.name, data.providerType, data.modelId, data.baseUrl,
       encryptApiKey(data.apiKey), data.contextWindow, data.maxOutputTokens,
       data.inputPricePer1k ?? 0, data.outputPricePer1k ?? 0,
       data.isEnabled === false ? 0 : 1]);
  }

  async update(modelKey: string, data: Partial<Omit<LlmModel, 'isEnabled'>>): Promise<void> {
    const sets: string[] = []; const args: (string | number | null)[] = [];
    if (data.name !== undefined) { sets.push('name = ?'); args.push(data.name); }
    if (data.providerType !== undefined) { sets.push('provider_type = ?'); args.push(data.providerType); }
    if (data.modelId !== undefined) { sets.push('model_id = ?'); args.push(data.modelId); }
    if (data.baseUrl !== undefined) { sets.push('base_url = ?'); args.push(data.baseUrl); }
    if (data.apiKey !== undefined && data.apiKey !== '') { sets.push('api_key = ?'); args.push(encryptApiKey(data.apiKey)); }
    if (data.contextWindow !== undefined) { sets.push('context_window = ?'); args.push(data.contextWindow); }
    if (data.maxOutputTokens !== undefined) { sets.push('max_output_tokens = ?'); args.push(data.maxOutputTokens); }
    if (data.inputPricePer1k !== undefined) { sets.push('input_price_per_1k = ?'); args.push(data.inputPricePer1k); }
    if (data.outputPricePer1k !== undefined) { sets.push('output_price_per_1k = ?'); args.push(data.outputPricePer1k); }
    if (sets.length === 0) return;
    sets.push('updated_at = CURRENT_TIMESTAMP(3)');
    args.push(modelKey);
    await this.pool.execute(`UPDATE llm_models SET ${sets.join(', ')} WHERE model_key = ?`, args);
  }

  async setEnabled(modelKey: string, enabled: boolean): Promise<void> {
    await this.pool.execute(
      'UPDATE llm_models SET is_enabled = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE model_key = ?',
      [enabled ? 1 : 0, modelKey]);
  }

  private mapRow(r: LlmModelRow): LlmModel {
    return {
      modelKey: r.model_key, name: r.name, providerType: r.provider_type,
      modelId: r.model_id, baseUrl: r.base_url, apiKey: decryptApiKey(r.api_key),
      contextWindow: r.context_window, maxOutputTokens: r.max_output_tokens, isEnabled: r.is_enabled === 1,
      inputPricePer1k: Number(r.input_price_per_1k ?? 0),
      outputPricePer1k: Number(r.output_price_per_1k ?? 0),
    };
  }
}
