/**
 * 埋点日志的内存缓冲：攒批落库，**永不阻塞、永不抛、永不重试**。
 *
 * 设计要点：
 *   - push 是同步 O(1)，只入数组；到 flushAt 条或定时到点才异步落库
 *   - 超过 maxEntries 丢**最旧**的并累加 dropped（宁可丢样本，不可把内存吃光）
 *   - flush 失败：整批丢弃 + 计数，不做重试 —— 埋点故障绝不能放大成 DB 压力
 *   - stop() **只停定时器、不落库**；退出流程必须再显式 `await flushNow()` 兜最后一批
 *   - flush 进行中若又触发 flush，会被 `flushing` 守卫挡掉且**不会补排一次**：剩余行要等
 *     下一次 push 或下一个定时器。故 `start()` **必须**被调用，否则一波突发之后可能长期停滞
 */
export interface TelemetryBufferOptions {
  /** 仅用于日志标识 */
  name: string;
  maxEntries?: number;
  flushIntervalMs?: number;
  /** 达到该条数立即 flush */
  flushAt?: number;
}

export class TelemetryBuffer<T> {
  private rows: T[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private flushing = false;
  private droppedCount = 0;
  private failedFlushes = 0;
  private readonly maxEntries: number;
  private readonly flushIntervalMs: number;
  private readonly flushAt: number;

  constructor(
    private readonly flushFn: (rows: T[]) => Promise<void>,
    private readonly opts: TelemetryBufferOptions,
  ) {
    this.maxEntries = opts.maxEntries ?? 5000;
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.flushAt = opts.flushAt ?? 200;
  }

  get size(): number { return this.rows.length; }
  get dropped(): number { return this.droppedCount; }
  get failed(): number { return this.failedFlushes; }

  push(row: T): void {
    if (this.rows.length >= this.maxEntries) {
      this.rows.shift();
      this.droppedCount += 1;
    }
    this.rows.push(row);
    if (this.rows.length >= this.flushAt) void this.flushNow();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flushNow(); }, this.flushIntervalMs);
    // 别让定时器拖住进程退出
    this.timer.unref?.();
  }

  /**
   * 只停定时器，**不落库**。停止后请在退出流程里显式 `await flushNow()` 兜最后一批
   * （见 TelemetryService.onModuleDestroy）——`stop()` 故意不做这件事：它是同步的，
   * 而落库是异步的，藏一个「看起来同步、其实吞掉一个 Promise」的收尾更容易漏掉。
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async flushNow(): Promise<void> {
    if (this.flushing || this.rows.length === 0) return;
    this.flushing = true;
    const batch = this.rows;
    this.rows = [];
    try {
      await this.flushFn(batch);
    } catch {
      // 整批丢弃，不重试（重试会把故障放大）
      this.failedFlushes += 1;
    } finally {
      this.flushing = false;
    }
  }
}
