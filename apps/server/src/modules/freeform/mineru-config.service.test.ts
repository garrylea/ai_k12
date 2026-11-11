import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MineruConfigService } from './mineru-config.service.js';
import type { MineruConfigRepository, MineruConfigRecord } from '../../database/repositories/mineru-config.repo.js';
import type { MineruRunner } from './mineru-runner.js';

const DB_ROW: MineruConfigRecord = {
  enabled: true,
  bin: '/opt/mineru/bin/mineru-open-api',
  token: 'sk-db-token',
  timeoutMs: 45000,
  concurrency: 3,
};

function makeService(over: {
  row?: MineruConfigRecord | null;
  getError?: Error;
  runner?: { run: ReturnType<typeof vi.fn> };
} = {}) {
  const repo = {
    get: over.getError
      ? vi.fn().mockRejectedValue(over.getError)
      : vi.fn().mockResolvedValue(over.row === undefined ? DB_ROW : over.row),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const runner = over.runner ?? { run: vi.fn().mockResolvedValue(undefined) };
  const svc = new MineruConfigService(
    repo as unknown as MineruConfigRepository,
    runner as unknown as MineruRunner,
  );
  return { svc, repo, runner };
}

const ENV_KEYS = ['MINERU_TOKEN', 'MINERU_BIN', 'MINERU_TIMEOUT_MS', 'MINERU_CONCURRENCY'] as const;

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('MineruConfigService：库优先、env 兜底', () => {
  it('库里有行时，token/bin/超时/并发全部以库为准', async () => {
    process.env.MINERU_TOKEN = 'sk-env';
    process.env.MINERU_BIN = '/usr/local/bin/mineru-open-api';
    process.env.MINERU_TIMEOUT_MS = '90000';
    process.env.MINERU_CONCURRENCY = '2';
    const { svc } = makeService();

    const cfg = await svc.get();

    expect(cfg).toMatchObject({
      enabled: true,
      bin: '/opt/mineru/bin/mineru-open-api',
      token: 'sk-db-token',
      tokenSource: 'db',
      timeoutMs: 45000,
      concurrency: 3,
    });
  });

  it('库无行时回落 env（含 tokenSource=env）', async () => {
    process.env.MINERU_TOKEN = 'sk-env';
    process.env.MINERU_BIN = '/env/mineru';
    process.env.MINERU_TIMEOUT_MS = '20000';
    process.env.MINERU_CONCURRENCY = '1';
    const { svc } = makeService({ row: null });

    const cfg = await svc.get();

    expect(cfg).toMatchObject({
      enabled: true,
      bin: '/env/mineru',
      token: 'sk-env',
      tokenSource: 'env',
      timeoutMs: 20000,
      concurrency: 1,
    });
  });

  it('库里 token 为空串时回落 env token，其余字段仍以库为准', async () => {
    process.env.MINERU_TOKEN = 'sk-env';
    const { svc } = makeService({ row: { ...DB_ROW, token: '' } });

    const cfg = await svc.get();

    expect(cfg.token).toBe('sk-env');
    expect(cfg.tokenSource).toBe('env');
    expect(cfg.bin).toBe('/opt/mineru/bin/mineru-open-api');
  });

  it('库和 env 都没有 token → tokenSource=none、token 空串', async () => {
    const { svc } = makeService({ row: null });
    const cfg = await svc.get();
    expect(cfg.token).toBe('');
    expect(cfg.tokenSource).toBe('none');
  });

  it('读库失败不抛，按 env 继续（表没迁移也不能让识题整体不可用）', async () => {
    process.env.MINERU_TOKEN = 'sk-env';
    const { svc } = makeService({ getError: new Error("Table 'mineru_config' doesn't exist") });

    const cfg = await svc.get();

    expect(cfg.token).toBe('sk-env');
    expect(cfg.tokenSource).toBe('env');
  });

  it('30s 内命中缓存，不重复读库；save 后立即失效', async () => {
    const { svc, repo } = makeService();
    await svc.get();
    await svc.get();
    expect(repo.get).toHaveBeenCalledTimes(1);

    await svc.save({ enabled: true, bin: 'mineru-open-api', timeoutMs: 60000, concurrency: 2 });
    await svc.get();
    expect(repo.get).toHaveBeenCalledTimes(2);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 60000, concurrency: 2 }),
    );
  });

  it('缓存过期后重新读库', async () => {
    vi.useFakeTimers();
    const { svc, repo } = makeService();
    await svc.get();
    vi.advanceTimersByTime(30_001);
    await svc.get();
    expect(repo.get).toHaveBeenCalledTimes(2);
  });

  it('view 只回掩码与来源，绝不回明文 token', async () => {
    const { svc } = makeService();
    const view = await svc.view();
    expect(view).toMatchObject({
      enabled: true,
      bin: '/opt/mineru/bin/mineru-open-api',
      tokenMasked: 'sk-***ken',
      tokenSource: 'db',
      timeoutMs: 45000,
      concurrency: 3,
    });
    expect(JSON.stringify(view)).not.toContain('sk-db-token');
  });
});

describe('MineruConfigService.validate', () => {
  it('runner 成功写出 md → ok=true 且返回样例文本，临时目录被清理', async () => {
    const runner = {
      run: vi.fn(async (_files: string[], outDir: string, _cfg?: unknown) => {
        await fs.writeFile(path.join(outDir, 'probe.md'), '# 1+1=?\n');
      }),
    };
    const { svc } = makeService({ runner });

    const res = await svc.validate();

    expect(res.ok).toBe(true);
    expect(res.sample).toBe('# 1+1=?');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    const [, outDir, cfg] = runner.run.mock.calls[0];
    expect(cfg).toMatchObject({ bin: '/opt/mineru/bin/mineru-open-api', token: 'sk-db-token' });
    // 临时目录在 finally 里删掉
    await expect(fs.stat(outDir)).rejects.toBeTruthy();
  });

  it('runner 抛错 → ok=false，原因原样返回（供后台展示）', async () => {
    const runner = { run: vi.fn().mockRejectedValue(new Error('MinerU 退出码 1：401 bad token')) };
    const { svc } = makeService({ runner });

    const res = await svc.validate();

    expect(res.ok).toBe(false);
    expect(res.sample).toContain('401 bad token');
  });

  it('探活超时不跟随生产超时无上限（封顶 60s）', async () => {
    const runner = { run: vi.fn().mockResolvedValue(undefined) };
    const { svc } = makeService({ runner, row: { ...DB_ROW, timeoutMs: 600_000 } });

    await svc.validate();

    const [, , cfg] = runner.run.mock.calls[0];
    expect(cfg.timeoutMs).toBe(60_000);
  });
});
