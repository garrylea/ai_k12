import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { encryptApiKey, decryptApiKey } from '../../common/utils/api-key-crypto.js';

export interface MineruConfigRow extends RowDataPacket {
  id: number;
  is_enabled: number;
  bin: string;
  token: string;
  timeout_ms: number;
  concurrency: number;
}

export interface MineruConfigRecord {
  enabled: boolean;
  bin: string;
  token: string;
  timeoutMs: number;
  concurrency: number;
}

export interface MineruConfigSaveInput {
  enabled: boolean;
  bin: string;
  /** 空串 = 不改 token（与 llm_models 的 apiKey 更新语义一致）。 */
  token?: string;
  timeoutMs: number;
  concurrency: number;
}

/**
 * `mineru_config` 单行表（id 固定 1）。token 与 `llm_models.api_key` 同样加密存储，
 * 读写都只在仓储层做加解密，上层拿到的永远是明文（且不得落日志）。
 */
@Injectable()
export class MineruConfigRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async get(): Promise<MineruConfigRecord | null> {
    const [rows] = await this.pool.execute<MineruConfigRow[]>(
      'SELECT * FROM mineru_config WHERE id = 1',
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      enabled: r.is_enabled === 1,
      bin: r.bin,
      token: r.token ? decryptApiKey(r.token) : '',
      timeoutMs: r.timeout_ms,
      concurrency: r.concurrency,
    };
  }

  async save(data: MineruConfigSaveInput): Promise<void> {
    // 不传 token 时只在 INSERT 里写空串；行已存在则 ON DUPLICATE 分支不改 token。
    const token = data.token ? encryptApiKey(data.token) : '';
    const keepTokenSql = data.token ? ', token = VALUES(token)' : '';
    await this.pool.execute(
      `INSERT INTO mineru_config (id, is_enabled, bin, token, timeout_ms, concurrency)
       VALUES (1, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         is_enabled = VALUES(is_enabled),
         bin = VALUES(bin),
         timeout_ms = VALUES(timeout_ms),
         concurrency = VALUES(concurrency)${keepTokenSql}`,
      [data.enabled ? 1 : 0, data.bin, token, data.timeoutMs, data.concurrency],
    );
  }
}
