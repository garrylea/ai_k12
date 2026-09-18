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
  it('按 subject_id 升序返回去重后的已开始学科 id', async () => {
    const pool = mockPool([{ subject_id: 1 }, { subject_id: 3 }]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.listTrackedSubjectIds(9);

    expect(result).toEqual([1, 3]);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('FROM progress');
    expect(sql).toContain('student_id = ?');
    // 标题里的「去重」「升序」必须真的被验证，否则查重/乱序也全绿。
    expect(sql).toContain('DISTINCT');
    expect(sql).toContain('ORDER BY subject_id');
    expect(pool.execute.mock.calls[0][1]).toEqual([9]);
  });

  it('排除 status=not_started 的行（只配了教材、根本没开始学）', async () => {
    const pool = mockPool([]);
    const repo = new ParentInsightsRepository(pool as any);

    await repo.listTrackedSubjectIds(9);

    const sql = pool.execute.mock.calls[0][0] as string;
    // progress 行存在 ≠ 已开始：家长在「学习配置」里配教材（createConfig）或
    // applyConfig(reset=true) 会写入 status='not_started' 的行。不排除的话，
    // 仪表盘会为「只配过教材」的学科渲染卡片，与 spec §4.2 ① 的意图相反。
    expect(sql).toContain("status <> 'not_started'");
  });

  it('无 progress 行 → 空数组', async () => {
    const repo = new ParentInsightsRepository(mockPool([]) as any);
    expect(await repo.listTrackedSubjectIds(9)).toEqual([]);
  });
});

/**
 * 从一条活跃度 SQL 里抽出并集子查询引用的来源表（FROM / JOIN），归一化后排序。
 * 用来钉住「全时段 MAX 与窗口内计数共用同一份来源定义」——两条 SQL 的来源集合必须相等，
 * 否则有人只给其中一条增删活跃来源，两个指标口径就会悄悄分叉。
 */
const unionSources = (sql: string): string[] =>
  (sql.match(/(?:FROM|JOIN)\s+[a-z_]+/gi) ?? [])
    .map((s) => s.replace(/\s+/g, ' ').toLowerCase())
    .sort();

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

    const daysSql = pool.execute.mock.calls[1][0] as string;
    // 窗口内查询：4 个 student_id + 4 个下界
    expect(pool.execute.mock.calls[1][1]).toHaveLength(8);
    expect(daysSql).toContain('COUNT(DISTINCT DATE(ts))');
    expect(daysSql).toContain('ai_dialogues');

    // 两条查询共用同一份四路来源定义：来源集合必须逐一相等。
    const expectedSources = [
      'from ai_messages',
      'from exam_sessions',
      'from point_ledger',
      'from practice_results',
      'join ai_dialogues',
    ];
    expect(unionSources(maxSql)).toEqual(expectedSources);
    expect(unionSources(daysSql)).toEqual(expectedSources);
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
