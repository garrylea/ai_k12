import { spawn } from 'node:child_process';

/** MinerU CLI 调用失败（含未配置 token / 超时 / 取消 / 非 0 退出）。 */
export class FreeformMineruError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreeformMineruError';
  }
}

export const DEFAULT_MINERU_BIN = 'mineru-open-api';
export const DEFAULT_MINERU_TIMEOUT_MS = 90000;
export const DEFAULT_MINERU_CONCURRENCY = 2;

/** 调用参数由 `MineruConfigService` 解析后显式传入（DB 优先、env 兜底），runner 不再直接读环境变量。 */
export interface MineruRunConfig {
  bin: string;
  token: string;
  timeoutMs: number;
}
/** CLI 自身已有 --timeout，本地定时器多给 5s 宽限，避免与子进程超时抢跑。 */
const TIMEOUT_GRACE_MS = 5000;
const STDERR_TAIL = 500;
/** stderr 缓冲区上限：只影响内存，最终错误仍取最后 500 字符（远小于此，截断点不会落到 token 中间）。 */
const STDERR_BUFFER = 4096;

/** 错误信息里绝不带出 token。 */
function redact(text: string, token: string): string {
  return token ? text.split(token).join('***') : text;
}

export class MineruRunner {
  async run(
    files: string[],
    outDir: string,
    config: MineruRunConfig,
    signal?: AbortSignal,
  ): Promise<void> {
    const bin = config.bin || DEFAULT_MINERU_BIN;
    const token = config.token;
    if (!token) throw new FreeformMineruError('MINERU_TOKEN 未配置');
    if (signal?.aborted) throw new FreeformMineruError('MinerU 已取消');
    const configuredTimeout = Number(config.timeoutMs);
    const timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_MINERU_TIMEOUT_MS;

    // 文件、输出目录都走 argv 数组，shell:false —— 不经过 shell，无注入面。
    const args = [
      'extract',
      ...files,
      '-o',
      outDir,
      '-f',
      'md',
      '--timeout',
      String(Math.max(1, Math.round(timeoutMs / 1000))),
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, {
        shell: false,
        env: { ...process.env, MINERU_TOKEN: token },
      });

      let stderr = '';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new FreeformMineruError(message));
      };
      const onAbort = () => {
        child.kill('SIGKILL');
        fail('MinerU 已取消');
      };

      timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail('MinerU 超时');
      }, timeoutMs + TIMEOUT_GRACE_MS);

      if (signal) {
        if (signal.aborted) {
          child.kill('SIGKILL');
          fail('MinerU 已取消');
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stderr?.on('data', (d: Buffer) => {
        // 只留尾部：嘈杂子进程的输出不能无界涨内存；最终错误仍只取最后 500 字符。
        stderr = (stderr + d.toString()).slice(-STDERR_BUFFER);
      });
      child.on('error', (err: Error) => {
        fail(`MinerU 启动失败：${redact(err.message, token)}`);
      });
      child.on('close', (code: number | null) => {
        if (settled) return;
        if (code === 0) {
          settled = true;
          cleanup();
          resolve();
          return;
        }
        const tail = redact(stderr, token).slice(-STDERR_TAIL);
        fail(`MinerU 退出码 ${code}：${tail}`);
      });
    });
  }
}

/** 进程内并发限制：最多 N 个 MinerU 任务同时跑；超出的排队。 */
export class MineruLimiter {
  private active = 0;
  private max: number;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  /**
   * 并发上限来自数据库配置，可热改。调小到低于当前 active 时不打断在跑的任务，
   * 新任务等 active 回落到新上限以下才放行（随后由 release() 交接）。
   */
  setMax(max: number): void {
    this.max = Math.max(1, Math.floor(max));
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** 拿到名额时 active 立即 +1；排队者不计数，名额由 release() 交接（见下）。 */
  private acquire(): Promise<void> | void {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * 名额交接而非「先减后唤醒」：直接把当前名额转给等待者，active 保持不变，
   * 这样新来的 run() 在交接窗口内看到的仍是 active === max，只能排队，不会瞬时超卖。
   */
  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active -= 1;
  }
}

/**
 * 模块级单例：MinerU 只在图片识题时使用，且真源是数据库（`mineru_config`），
 * 这里仅用 env 作初始值 —— `MineruConfigService` 每次取到有效配置后会 `setMax()` 覆盖。
 */
const concurrency = Number(process.env.MINERU_CONCURRENCY ?? DEFAULT_MINERU_CONCURRENCY);
export const mineruLimiter = new MineruLimiter(
  Number.isFinite(concurrency) && concurrency >= 1
    ? Math.floor(concurrency)
    : DEFAULT_MINERU_CONCURRENCY,
);
