import { afterEach, describe, expect, it, vi } from 'vitest';
import { newSessionUid } from './sessionUid';

afterEach(() => vi.unstubAllGlobals());

describe('newSessionUid', () => {
  it('优先用 crypto.randomUUID', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    vi.stubGlobal('crypto', { randomUUID: () => uuid });
    expect(newSessionUid()).toBe(uuid);
  });

  it('无 crypto（局域网 http 非 secure context）时降级但仍返回非空串', () => {
    vi.stubGlobal('crypto', undefined);
    const a = newSessionUid();
    const b = newSessionUid();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b); // 两次不同（时间戳+随机）
  });

  it('crypto 存在但没有 randomUUID 时同样降级', () => {
    vi.stubGlobal('crypto', {});
    expect(newSessionUid().length).toBeGreaterThan(0);
  });
});
