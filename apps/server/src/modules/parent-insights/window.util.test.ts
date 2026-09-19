import { describe, it, expect, vi, afterEach } from 'vitest';
import { startOfDaysAgo, resolveWindow, resolveRange } from './window.util.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('window.util', () => {
  it('startOfDaysAgo(0) = 今天 00:00', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:30:00'));

    const d = startOfDaysAgo(0);

    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getDate()).toBe(18);
  });

  it('startOfDaysAgo(6) 落在 6 天前的 00:00', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:30:00'));

    const d = startOfDaysAgo(6);

    expect(d.getDate()).toBe(12);
    expect(d.getHours()).toBe(0);
  });

  it('weekly = 近 7 天（含今天），endExclusive 是次日 00:00', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:30:00'));

    const w = resolveWindow('weekly');

    expect(w.startDay).toBe('2026-09-12');
    expect(w.endDay).toBe('2026-09-18');
    expect(w.endExclusive.getDate()).toBe(19);
    expect(w.endExclusive.getHours()).toBe(0);
  });

  it('monthly = 近 30 天', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:30:00'));

    const w = resolveWindow('monthly');

    expect(w.startDay).toBe('2026-08-20');
    expect(w.endDay).toBe('2026-09-18');
  });
});

describe('resolveRange', () => {
  it('两个都不传 → 近 7 天（含今天），endExclusive 是明天的 00:00', () => {
    const w = resolveRange();
    const today = new Date();
    expect(w.endDay).toBe(
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
    );
    expect(Math.round((w.endExclusive.getTime() - w.start.getTime()) / 86_400_000)).toBe(7);
  });

  it('显式 from/to → 闭区间：to 那天整天都在窗口内', () => {
    const w = resolveRange('2026-09-13', '2026-09-19');
    expect(w.startDay).toBe('2026-09-13');
    expect(w.endDay).toBe('2026-09-19');
    expect(Math.round((w.endExclusive.getTime() - w.start.getTime()) / 86_400_000)).toBe(7);
    expect(w.endExclusive.getTime() - w.start.getTime()).toBe(7 * 86_400_000);
  });

  it('只给 to → 以 to 收尾的 7 天窗口', () => {
    const w = resolveRange(undefined, '2026-09-19');
    expect(w.startDay).toBe('2026-09-13');
    expect(w.endDay).toBe('2026-09-19');
  });

  it('非法日期串 → 回落默认（查询参数宽容，不 400）', () => {
    const w = resolveRange('2026-9-3', 'garbage');
    expect(w.startDay).not.toBe('2026-9-3');
    expect(w.endDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('from > to → 交换，不返回空窗口', () => {
    const w = resolveRange('2026-09-19', '2026-09-13');
    expect(w.startDay).toBe('2026-09-13');
    expect(w.endDay).toBe('2026-09-19');
  });
});
