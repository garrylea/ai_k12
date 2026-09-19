import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ParentAnalyticsRepository } from './parent-analytics.repo.js';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
});

const FROM = new Date(2026, 8, 13); // 2026-09-13 本地 00:00
const TO = new Date(2026, 8, 20); // 2026-09-20 本地 00:00（半开）

describe('ParentAnalyticsRepository 学习时长', () => {
  it('getStudyTimeTotal：只算已结束（含惰性可收尾的孤儿会话）', async () => {
    const pool = mockPool([{ total: 3661 }]);
    const repo = new ParentAnalyticsRepository(pool as any);
    expect(await repo.getStudyTimeTotal(9, FROM, TO)).toBe(3661);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM study_sessions');
    expect(sql).toContain("status IN ('ended','abandoned')");
    // 关标签的会话不会有 end 请求，必须把「active 但心跳超 5 分钟」也算进来
    expect(sql).toContain("status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE");
    expect(sql).toContain('student_id = ? AND started_at >= ? AND started_at < ?');
    expect(sql).not.toContain('CURDATE()');
    expect(params).toEqual([9, FROM, TO]);
  });

  it('getStudyTimeByDay：按 DATE(started_at) 分组，日期由 SQL 出', async () => {
    const rows = [
      { day: '2026-09-13', seconds: 600 },
      { day: '2026-09-15', seconds: 1200 },
    ];
    const pool = mockPool(rows);
    const repo = new ParentAnalyticsRepository(pool as any);
    expect(await repo.getStudyTimeByDay(9, FROM, TO)).toEqual(rows);

    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain("DATE_FORMAT(started_at, '%Y-%m-%d') AS day");
    expect(sql).toContain('GROUP BY day ORDER BY day');
  });

  it('getStudyTimeByModule / bySubject：NULL 维度不出现在结果里（不编造「未知」桶）', async () => {
    const pool = mockPool([{ module: 'en_vocabulary', seconds: 300 }]);
    const repo = new ParentAnalyticsRepository(pool as any);
    await repo.getStudyTimeByModule(9, FROM, TO);
    const [moduleSql] = pool.execute.mock.calls[0];
    expect(moduleSql).toContain('GROUP BY module ORDER BY seconds DESC');

    const subjectPool = mockPool([{ subjectId: 1, seconds: 300 }]);
    const repo2 = new ParentAnalyticsRepository(subjectPool as any);
    await repo2.getStudyTimeBySubject(9, FROM, TO);
    const [subjectSql] = subjectPool.execute.mock.calls[0];
    expect(subjectSql).toContain('subject_id IS NOT NULL');
    expect(subjectSql).toContain('GROUP BY subject_id ORDER BY seconds DESC');
  });

  it('getActiveDays：COUNT(DISTINCT DATE(started_at))，空结果为 0', async () => {
    const pool = mockPool([{ active_days: 4 }]);
    const repo = new ParentAnalyticsRepository(pool as any);
    expect(await repo.getActiveDays(9, FROM, TO)).toBe(4);

    const empty = mockPool([]);
    const repo2 = new ParentAnalyticsRepository(empty as any);
    expect(await repo2.getActiveDays(9, FROM, TO)).toBe(0);
  });
});

/**
 * 隐私守卫（spec §5.4 第三道锁）：
 * `parent-analytics.repo.ts` 是家长端取数的**唯一**入口，文件里**不允许出现**任何
 * ops-only 信号名。这是穷尽式断言——将来谁把 `behavior_events` 的 ops 事件查进来，
 * 这条用例会立刻红。
 */
describe('隐私守卫：家长端仓储不含 ops 信号', () => {
  it('源码里不出现 ops-only 事件名', () => {
    const path = fileURLToPath(new URL('./parent-analytics.repo.ts', import.meta.url));
    const src = readFileSync(path, 'utf8');
    for (const forbidden of [
      'hint_requested',
      'answer_revealed',
      'self_assess_answered',
      'consecutive_failures',
      'study_session_idle',
      'behavior_events',
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });
});
