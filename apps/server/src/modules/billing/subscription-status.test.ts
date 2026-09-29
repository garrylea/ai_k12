import { describe, it, expect } from 'vitest';
import { effectiveStatus, daysRemaining } from './subscription-status.js';

const D = (s: string) => new Date(s);

describe('effectiveStatus', () => {
  it('试用期内 -> trialing；截止当刻仍有效', () => {
    const t = { trialEndsAt: D('2026-10-06T00:00:00Z'), currentPeriodEnd: null };
    expect(effectiveStatus(D('2026-09-29T00:00:00Z'), t)).toBe('trialing');
    expect(effectiveStatus(D('2026-10-06T00:00:00Z'), t)).toBe('trialing');
  });
  it('试用过期且无付费 -> expired', () => {
    const t = { trialEndsAt: D('2026-10-06T00:00:00Z'), currentPeriodEnd: null };
    expect(effectiveStatus(D('2026-10-06T00:00:01Z'), t)).toBe('expired');
  });
  it('付费期内 -> active（优先于 trial 时刻）', () => {
    const t = { trialEndsAt: D('2026-09-01T00:00:00Z'), currentPeriodEnd: D('2026-10-29T00:00:00Z') };
    expect(effectiveStatus(D('2026-09-29T00:00:00Z'), t)).toBe('active');
  });
  it('付费过期 -> expired（含两者皆 null：无行/从未付费）', () => {
    expect(effectiveStatus(D('2026-11-01T00:00:00Z'), { trialEndsAt: null, currentPeriodEnd: D('2026-10-29T00:00:00Z') })).toBe('expired');
    expect(effectiveStatus(D('2026-09-29T00:00:00Z'), { trialEndsAt: null, currentPeriodEnd: null })).toBe('expired');
  });
});

describe('daysRemaining', () => {
  it('向上取整且不为负', () => {
    expect(daysRemaining(D('2026-09-29T00:00:00Z'), D('2026-09-30T01:00:00Z'))).toBe(2); // 25h -> ceil 2
    expect(daysRemaining(D('2026-09-29T00:00:00Z'), D('2026-09-29T00:00:00Z'))).toBe(0);
    expect(daysRemaining(D('2026-09-30T00:00:00Z'), D('2026-09-29T00:00:00Z'))).toBe(0);
  });
});
