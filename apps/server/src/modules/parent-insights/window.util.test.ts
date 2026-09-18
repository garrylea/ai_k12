import { describe, it, expect, vi, afterEach } from 'vitest';
import { startOfDaysAgo, resolveWindow } from './window.util.js';

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
