import { describe, it, expect, vi } from 'vitest';
import { ParentInsightsRepository } from './parent-insights.repo.js';

/**
 * mockPool 模拟 mysql2 的 pool 双返回形状：[rows, fields]。
 * SELECT 走 execute 或 query，两者都要给。
 */
const mockPool = (rows: any[] = [], insertId = 7) => ({
  execute: vi.fn().mockImplementation((sql: string) => {
    const trimmed = sql.trim();
    if (/^INSERT/i.test(trimmed)) {
      return Promise.resolve([{ insertId, affectedRows: 1 }, []]);
    }
    return Promise.resolve([rows, []]);
  }),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('ParentInsightsRepository：已开始学科', () => {
  it('按 subject_id 升序返回去重后的学科 id', async () => {
    const pool = mockPool([{ subject_id: 1 }, { subject_id: 3 }]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.listTrackedSubjectIds(9);

    expect(result).toEqual([1, 3]);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('FROM progress');
    expect(sql).toContain('student_id = ?');
    expect(pool.execute.mock.calls[0][1]).toEqual([9]);
  });

  it('无 progress 行 → 空数组', async () => {
    const repo = new ParentInsightsRepository(mockPool([]) as any);
    expect(await repo.listTrackedSubjectIds(9)).toEqual([]);
  });
});

describe('ParentInsightsRepository：活跃度', () => {
  it('lastActiveAt 取全时段 MAX，activeDays 只数窗口内的天', async () => {
    const pool = mockPool([]);
    // 第一次 execute = lastActiveAt（全时段），第二次 = activeDays（窗口内）
    pool.execute
      .mockResolvedValueOnce([[{ last_active_at: new Date('2026-09-18T12:00:00Z') }], []])
      .mockResolvedValueOnce([[{ active_days: 3 }], []]);

    const repo = new ParentInsightsRepository(pool as any);
    const result = await repo.getActivitySummary(9, new Date('2026-09-12T00:00:00Z'));

    expect(result.lastActiveAt?.toISOString()).toBe('2026-09-18T12:00:00.000Z');
    expect(result.activeDays).toBe(3);

    const maxSql = pool.execute.mock.calls[0][0] as string;
    // 全时段查询**不带**时间条件（只有 4 个 student_id 参数）
    expect(pool.execute.mock.calls[0][1]).toEqual([9, 9, 9, 9]);
    expect(maxSql).toContain('practice_results');
    expect(maxSql).toContain('point_ledger');
    expect(maxSql).toContain('exam_sessions');
    expect(maxSql).toContain('ai_messages');

    const daysSql = pool.execute.mock.calls[1][0] as string;
    expect(daysSql).toContain('COUNT(DISTINCT DATE(ts))');
    // 窗口内查询：4 个 student_id + 4 个下界
    expect(pool.execute.mock.calls[1][1]).toHaveLength(8);
  });

  it('完全无记录 → lastActiveAt null、activeDays 0', async () => {
    const pool = mockPool([]);
    pool.execute
      .mockResolvedValueOnce([[{ last_active_at: null }], []])
      .mockResolvedValueOnce([[{ active_days: 0 }], []]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getActivitySummary(9, new Date('2026-09-12T00:00:00Z'));

    expect(result.lastActiveAt).toBeNull();
    expect(result.activeDays).toBe(0);
  });
});
