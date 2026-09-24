import { describe, it, expect, vi } from 'vitest';
import { LearningSessionLogService } from './learning-session-log.service.js';
import type { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';

const NOW = new Date('2026-09-23T02:00:00.000Z');

const mkRepo = (rows: unknown[], total = rows.length) =>
  ({
    listByStudent: vi.fn().mockResolvedValue(rows),
    countByStudent: vi.fn().mockResolvedValue(total),
  } as unknown as LearningSessionsRepository);

const row = (over: Record<string, unknown> = {}) => ({
  id: 7,
  student_id: 9,
  app_shell: 'electron',
  started_at: new Date('2026-09-23T01:00:00.000Z'),
  last_seen_at: NOW,
  ended_at: null,
  lock_minutes: 60,
  lock_expires_at: new Date('2026-09-23T02:00:00.000Z'),
  unlocked_at: null,
  unlocked_by_parent_id: null,
  ...over,
});

describe('LearningSessionLogService.list（spec §5.5）', () => {
  it('进行中且心跳在 45 秒内 → online: true', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const svc = new LearningSessionLogService(mkRepo([row()]));
    const out = await svc.list(9, 7, 50);
    expect(out.items[0].online).toBe(true);
    expect(out.items[0].endedAt).toBeNull();
    vi.useRealTimers();
  });

  it('进行中但心跳超 45 秒 → online: false（已断开）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const stale = new Date(NOW.getTime() - 46_000);
    const svc = new LearningSessionLogService(mkRepo([row({ last_seen_at: stale })]));
    expect((await svc.list(9, 7, 50)).items[0].online).toBe(false);
    vi.useRealTimers();
  });

  it('已结束的会话永远 online: false（哪怕 last_seen_at 很新）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const svc = new LearningSessionLogService(
      mkRepo([row({ ended_at: new Date('2026-09-23T01:30:00.000Z') })]),
    );
    const out = await svc.list(9, 7, 50);
    expect(out.items[0].online).toBe(false);
    expect(out.items[0].endedAt).toBe('2026-09-23T01:30:00.000Z');
    vi.useRealTimers();
  });

  it('空结果是正常态：items 空、total 0（不抛错）', async () => {
    const svc = new LearningSessionLogService(mkRepo([], 0));
    expect(await svc.list(9, 7, 50)).toEqual({ items: [], total: 0 });
  });
});
