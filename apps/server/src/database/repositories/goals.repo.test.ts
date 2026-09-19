import { describe, it, expect, vi } from 'vitest';
import { GoalsRepository } from './goals.repo.js';

const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([[], []]),
  query: vi.fn().mockResolvedValue([[], []]),
});

describe('GoalsRepository', () => {
  it('ensureDefaults：必须用 INSERT IGNORE（否则会覆盖家长已设的值）', async () => {
    const pool = mockPool();
    const repo = new GoalsRepository(pool as any);

    await repo.ensureDefaults(11, [
      { metric: 'daily_study_minutes', period: 'daily', title: '每日学习时长', target: 60 },
      { metric: 'daily_words', period: 'daily', title: '每日背单词', target: 20 },
    ]);

    expect(pool.execute).toHaveBeenCalledTimes(2);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT IGNORE INTO goals');
    expect(sql).not.toContain('ON DUPLICATE KEY UPDATE');
    expect(pool.execute.mock.calls[0][1]).toEqual([11, 'daily_study_minutes', 'daily', '每日学习时长', 60]);
  });

  it('ensureDefaults：空数组不发任何 SQL', async () => {
    const pool = mockPool();
    const repo = new GoalsRepository(pool as any);

    await repo.ensureDefaults(11, []);

    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('upsertTarget：ON DUPLICATE KEY UPDATE 更新目标值并把 is_active 置回 1', async () => {
    const pool = mockPool();
    const repo = new GoalsRepository(pool as any);

    await repo.upsertTarget(11, 'weekly_passages', 'weekly', '每周古诗文篇目', 8);

    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO goals');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('target_value = new.target_value');
    expect(sql).toContain('is_active    = 1');
    expect(pool.execute.mock.calls[0][1]).toEqual([11, 'weekly_passages', 'weekly', '每周古诗文篇目', 8]);
  });

  it('findActiveByStudent：只取 is_active=1，返回 camelCase 且 Number() 化', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([
      [{ id: 7, metric: 'daily_words', period: 'daily', target_value: '20', title: '每日背单词' }],
      [],
    ]);
    const repo = new GoalsRepository(pool as any);

    const rows = await repo.findActiveByStudent(11);

    expect(rows).toEqual([
      { id: 7, metric: 'daily_words', period: 'daily', targetValue: 20, title: '每日背单词' },
    ]);
    expect(pool.execute.mock.calls[0][0]).toContain('is_active = 1');
    expect(pool.execute.mock.calls[0][1]).toEqual([11]);
  });
});
