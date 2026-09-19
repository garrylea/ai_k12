import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelemetryBuffer } from './telemetry-buffer';

describe('TelemetryBuffer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const mk = (flush = vi.fn().mockResolvedValue(undefined)) => ({
    flush,
    buf: new TelemetryBuffer<{ n: number }>(flush, { name: 't', maxEntries: 3, flushIntervalMs: 1000, flushAt: 2 }),
  });

  it('达到 flushAt 立即 flush', async () => {
    const { flush, buf } = mk();
    buf.push({ n: 1 });
    expect(flush).not.toHaveBeenCalled();
    buf.push({ n: 2 });
    await vi.waitFor(() => expect(flush).toHaveBeenCalledWith([{ n: 1 }, { n: 2 }]));
  });

  it('定时到点 flush 未满的批次', async () => {
    const { flush, buf } = mk();
    buf.start();
    buf.push({ n: 1 });
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledWith([{ n: 1 }]));
    buf.stop();
  });

  it('超过 maxEntries 丢最旧并计数 dropped，保留最新', async () => {
    // 用 flushAt:100 让 flush 不介入，才能确定性地观察丢弃行为
    const flush = vi.fn().mockResolvedValue(undefined);
    const buf = new TelemetryBuffer<{ n: number }>(flush, { name: 't', maxEntries: 3, flushIntervalMs: 1000, flushAt: 100 });
    for (let n = 1; n <= 5; n += 1) buf.push({ n });
    expect(buf.size).toBe(3);
    expect(buf.dropped).toBe(2);
    expect(flush).not.toHaveBeenCalled();   // flushAt=100 未到，不该触发
    await buf.flushNow();
    expect(flush).toHaveBeenCalledWith([{ n: 3 }, { n: 4 }, { n: 5 }]);  // 丢的是最旧的 1、2
  });

  it('flush 失败整批丢弃、不抛、不重试', async () => {
    const flush = vi.fn().mockRejectedValue(new Error('db down'));
    const buf = new TelemetryBuffer<{ n: number }>(flush, { name: 't', maxEntries: 10, flushIntervalMs: 1000, flushAt: 2 });
    buf.push({ n: 1 });
    expect(() => buf.push({ n: 2 })).not.toThrow();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    expect(buf.size).toBe(0);      // 失败后缓冲已清空
    expect(buf.failed).toBe(1);
  });

  it('flushNow 空缓冲不发请求', async () => {
    const { flush, buf } = mk();
    await buf.flushNow();
    expect(flush).not.toHaveBeenCalled();
  });
});
