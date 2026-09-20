import { describe, expect, it, vi } from 'vitest';
import { AdminAlertsService, RETENTION_DAYS } from './admin-alerts.service.js';
import type { SafetyAlertsRepository } from '../../database/repositories/safety-alerts.repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function mkRepo(over: {
  countOlderThan?: ReturnType<typeof vi.fn>;
  deleteOlderThan?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    countOlderThan: vi.fn().mockResolvedValue({ total: 0, unread: 0 }),
    deleteOlderThan: vi.fn().mockResolvedValue(0),
    ...over,
  };
}

function mkSvc(repo = mkRepo()) {
  return { svc: new AdminAlertsService(repo as unknown as SafetyAlertsRepository), repo };
}

describe('AdminAlertsService 保留期常量', () => {
  it('RETENTION_DAYS 固定 30（接口不带参数，要改就改这个常量）', () => {
    expect(RETENTION_DAYS).toBe(30);
  });
});

describe('AdminAlertsService.preview', () => {
  it('cutoff = now - 30 天，且与返回的 ISO 字符串是同一个时刻', async () => {
    const { svc, repo } = mkSvc();

    const before = Date.now();
    const out = await svc.preview();
    const after = Date.now();

    const [cutoff] = repo.countOlderThan.mock.calls[0];
    expect(cutoff).toBeInstanceOf(Date);
    // 容差窗口写法（同 safety-alerts.service.test.ts:146-147）：只钉「减了 30 天」，不钉毫秒
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - RETENTION_DAYS * DAY_MS);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - RETENTION_DAYS * DAY_MS);
    // 展示给前端的 cutoff 必须是传给仓储的那一个，不能各算一次
    expect(out.cutoff).toBe(cutoff.toISOString());
  });

  it('透传仓储的 total / unread，并带上 retentionDays', async () => {
    const repo = mkRepo({ countOlderThan: vi.fn().mockResolvedValue({ total: 42, unread: 7 }) });
    const { svc } = mkSvc(repo);

    const out = await svc.preview();

    expect(out.retentionDays).toBe(30);
    expect(out.total).toBe(42);
    expect(out.unread).toBe(7);
    expect(repo.countOlderThan).toHaveBeenCalledTimes(1);
    // 预览**不得**顺手删东西
    expect(repo.deleteOlderThan).not.toHaveBeenCalled();
  });

  it('仓储返回 0/0 时原样透传（不是把 0 当成「没数据」而省略）', async () => {
    const { svc } = mkSvc();

    const out = await svc.preview();

    expect(out.total).toBe(0);
    expect(out.unread).toBe(0);
  });
});

describe('AdminAlertsService.purge', () => {
  it('cutoff = now - 30 天，返回 deleted 与同一时刻的 cutoff', async () => {
    const repo = mkRepo({ deleteOlderThan: vi.fn().mockResolvedValue(9) });
    const { svc } = mkSvc(repo);

    const before = Date.now();
    const out = await svc.purge();
    const after = Date.now();

    const [cutoff] = repo.deleteOlderThan.mock.calls[0];
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - RETENTION_DAYS * DAY_MS);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - RETENTION_DAYS * DAY_MS);
    expect(out).toEqual({ retentionDays: 30, cutoff: cutoff.toISOString(), deleted: 9 });
  });

  it('没有任何过期行 → deleted = 0（不抛，不是 404）', async () => {
    const { svc } = mkSvc();

    await expect(svc.purge()).resolves.toMatchObject({ deleted: 0, retentionDays: 30 });
  });

  it('清理不先做预览（一次请求只打一条 DELETE，不额外查 COUNT）', async () => {
    const { svc, repo } = mkSvc();

    await svc.purge();

    expect(repo.deleteOlderThan).toHaveBeenCalledTimes(1);
    expect(repo.countOlderThan).not.toHaveBeenCalled();
  });
});
