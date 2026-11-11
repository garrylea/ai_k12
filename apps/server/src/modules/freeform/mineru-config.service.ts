import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MineruConfigRepository } from '../../database/repositories/mineru-config.repo.js';
import type { MineruConfigSaveInput } from '../../database/repositories/mineru-config.repo.js';
import { MINERU_PROBE_PNG_BASE64 } from './mineru-probe.js';
import {
  DEFAULT_MINERU_BIN,
  DEFAULT_MINERU_CONCURRENCY,
  DEFAULT_MINERU_TIMEOUT_MS,
  MineruRunner,
  mineruLimiter,
} from './mineru-runner.js';

/** 读库有成本，但配置要「保存即生效」：缓存 30s，save() 主动失效。 */
const CACHE_TTL_MS = 30_000;
/** 探活只跑一个几百字节的 HTML，不需要等满生产超时。 */
const VALIDATE_TIMEOUT_MS = 60_000;

export interface MineruEffectiveConfig {
  enabled: boolean;
  bin: string;
  token: string;
  timeoutMs: number;
  concurrency: number;
  /** token 来自哪里：db=后台配置；env=.env 兜底；none=都没配。 */
  tokenSource: 'db' | 'env' | 'none';
}

export interface MineruConfigView {
  enabled: boolean;
  bin: string;
  tokenMasked: string;
  tokenSource: MineruEffectiveConfig['tokenSource'];
  timeoutMs: number;
  concurrency: number;
}

/**
 * 做题入口识题的运行时配置：**数据库优先、env 兜底**（与模型配置同一口径）。
 *
 * 这条规则就是为了修「token 只在 shell/.env、重启即失效」的坑：后台保存后写库，
 * 识题调用时读库（30s 缓存 + save 失效），不再依赖进程启动时的环境。
 */
@Injectable()
export class MineruConfigService implements OnModuleInit {
  private readonly logger = new Logger(MineruConfigService.name);
  private cache: { value: MineruEffectiveConfig; at: number } | null = null;

  constructor(
    private readonly repo: MineruConfigRepository,
    private readonly runner: MineruRunner,
  ) {}

  async onModuleInit(): Promise<void> {
    const cfg = await this.get().catch(() => null);
    if (!cfg) return;
    if (!cfg.enabled) {
      this.logger.warn('识图（MinerU）已停用：做题入口的图片识别会直接返回 5503');
    } else if (!cfg.token) {
      this.logger.error(
        '识图（MinerU）未配置 Token：图片识别必定失败。请在后台「模型配置 → 识图（MinerU）」填写，或在 .env 设 MINERU_TOKEN',
      );
    }
  }

  /** 有效配置（缓存）。每次取到都把并发上限同步给 limiter，改库后无需重启。 */
  async get(): Promise<MineruEffectiveConfig> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.value;
    const value = await this.load();
    this.cache = { value, at: Date.now() };
    mineruLimiter.setMax(value.concurrency);
    return value;
  }

  /** 后台展示：token 只回掩码与来源，明文永不出服务端。 */
  async view(): Promise<MineruConfigView> {
    const cfg = await this.get();
    return {
      enabled: cfg.enabled,
      bin: cfg.bin,
      tokenMasked: maskToken(cfg.token),
      tokenSource: cfg.tokenSource,
      timeoutMs: cfg.timeoutMs,
      concurrency: cfg.concurrency,
    };
  }

  async save(input: MineruConfigSaveInput): Promise<void> {
    await this.repo.save(input);
    this.cache = null;
  }

  /**
   * 探活：拿内置的 2.3KB 小图（`1+1=?`）真跑一次 `extract`（token 错 / CLI 缺失 / 配额问题都会在这里暴露），
   * 成功后清理临时目录。与模型「测试连接」对齐：失败不抛，返回 ok=false + 原因。
   * ⚠️ 别改回 HTML 探活：同一 token 下 HTML 实测会卡 `timeout waiting for batch`。
   */
  async validate(): Promise<{ ok: boolean; latencyMs: number; sample: string }> {
    const cfg = await this.get();
    const t0 = Date.now();
    const work = path.join(os.tmpdir(), `mineru-validate-${randomUUID()}`);
    const out = path.join(work, 'out');
    try {
      await fs.mkdir(out, { recursive: true });
      const probe = path.join(work, 'probe.png');
      await fs.writeFile(probe, Buffer.from(MINERU_PROBE_PNG_BASE64, 'base64'));
      await this.runner.run([probe], out, {
        bin: cfg.bin,
        token: cfg.token,
        timeoutMs: Math.min(cfg.timeoutMs, VALIDATE_TIMEOUT_MS),
      });
      const files = await fs.readdir(out);
      const md = files.find((name) => name.endsWith('.md'));
      const text = md ? (await fs.readFile(path.join(out, md), 'utf-8')).trim() : '';
      return { ok: true, latencyMs: Date.now() - t0, sample: text.slice(0, 100) };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, sample: (err as Error).message };
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async load(): Promise<MineruEffectiveConfig> {
    let row: Awaited<ReturnType<MineruConfigRepository['get']>> = null;
    try {
      row = await this.repo.get();
    } catch (err) {
      // 表缺失/DB 抖动都不该让识题整体不可用：记一条 warn，按 env 继续跑。
      this.logger.warn(
        `读取 mineru_config 失败，回落 .env 的 MINERU_*：${(err as Error).message}`,
      );
    }

    const dbToken = (row?.token ?? '').trim();
    const envToken = (process.env.MINERU_TOKEN ?? '').trim();
    const token = dbToken || envToken;

    const dbTimeout = Number(row?.timeoutMs);
    const envTimeout = Number(process.env.MINERU_TIMEOUT_MS);
    const timeoutMs =
      Number.isFinite(dbTimeout) && dbTimeout > 0
        ? dbTimeout
        : Number.isFinite(envTimeout) && envTimeout > 0
          ? envTimeout
          : DEFAULT_MINERU_TIMEOUT_MS;

    const dbConcurrency = Number(row?.concurrency);
    const envConcurrency = Number(process.env.MINERU_CONCURRENCY);
    const concurrency =
      Number.isFinite(dbConcurrency) && dbConcurrency >= 1
        ? Math.floor(dbConcurrency)
        : Number.isFinite(envConcurrency) && envConcurrency >= 1
          ? Math.floor(envConcurrency)
          : DEFAULT_MINERU_CONCURRENCY;

    return {
      enabled: row ? row.enabled : true,
      bin: (row?.bin ?? '').trim() || process.env.MINERU_BIN?.trim() || DEFAULT_MINERU_BIN,
      token,
      tokenSource: dbToken ? 'db' : envToken ? 'env' : 'none',
      timeoutMs,
      concurrency,
    };
  }
}

function maskToken(token: string): string {
  return token.length > 8 ? `${token.slice(0, 3)}***${token.slice(-3)}` : token ? '***' : '';
}
