import { describe, expect, it, vi } from 'vitest';
import { OpsAnalyticsRepository, type OpsWindow } from './ops-analytics.repo.js';

const W: OpsWindow = {
  fromAt: '2026-10-03 00:00:00',
  toAt: '2026-10-10 00:00:00',
  todayAt: '2026-10-09 00:00:00',
  tomorrowAt: '2026-10-10 00:00:00',
};

/** results[i] = 第 i 次 pool.query 返回的 rows 数组（按调用顺序出队；resolve 的是 [rows, fields] 元组）。 */
function poolWithQueries(results: Array<Array<Record<string, unknown>>>) {
  const query = vi.fn();
  for (const r of results) query.mockResolvedValueOnce([r]);
  return { query } as any;
}

function allSql(pool: any): string {
  return pool.query.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

describe('OpsAnalyticsRepository', () => {
  it('overviewSessions：DAU 用 todayAt 参数、WAU 按学生去重、时长求和', async () => {
    const pool = poolWithQueries([[{ dau: 3 }], [{ students: 7, total_seconds: 7200 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.overviewSessions(W);
    expect(r).toEqual({ dau: 3, students: 7, totalSeconds: 7200 });

    const [dauSql, dauParams] = pool.query.mock.calls[0];
    expect(String(dauSql)).toContain('COUNT(DISTINCT student_id)');
    expect(dauParams).toEqual([W.todayAt, W.tomorrowAt]);

    const [winSql, winParams] = pool.query.mock.calls[1];
    expect(String(winSql)).toContain("status IN ('ended','abandoned')");
    expect(winParams).toEqual([W.fromAt, W.toAt]);

    // 全局约束：窗口边界一律应用层传参，SQL 内禁 CURDATE/NOW
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(/);
  });

  it('answerTotals：以 behavior_events.answer_submitted 为口径，正确数取 props.verdict', async () => {
    const pool = poolWithQueries([[{ answered: 12, correct: 8 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.answerTotals(W);
    expect(r).toEqual({ answered: 12, correct: 8 });

    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain("event = 'answer_submitted'");
    expect(String(sql)).toContain("props->>'$.verdict' = 'correct'");
    expect(params).toEqual([W.fromAt, W.toAt]);
  });

  it('moduleTop：GROUP BY module 按时长取 Top5', async () => {
    const pool = poolWithQueries([[{ module: 'mainline', students: 5, seconds: 6000 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.moduleTop(W);
    expect(r).toEqual([{ module: 'mainline', students: 5, seconds: 6000 }]);

    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('GROUP BY module');
    expect(String(sql)).toContain('LIMIT ?');
    expect(params).toEqual([W.fromAt, W.toAt, 5]);
  });

  it('modulesWindow：会话行与答题行按 module 合并，两边并集都保留', async () => {
    const pool = poolWithQueries([
      [
        { module: 'mainline', students: 5, seconds: 6000, sessions: 9 },
        { module: 'exam', students: 2, seconds: 1200, sessions: 3 },
      ],
      [{ module: 'exam', answered: 4, correct: 1 }],
    ]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.modulesWindow(W);
    expect(r).toEqual([
      { module: 'mainline', students: 5, seconds: 6000, sessions: 9, answered: 0, correct: 0 },
      { module: 'exam', students: 2, seconds: 1200, sessions: 3, answered: 4, correct: 1 },
    ]);
    expect(pool.query).toHaveBeenCalled();
    // 答题聚合走 behavior_events 且带窗口边界参数
    const [evSql, evParams] = pool.query.mock.calls[1];
    expect(String(evSql)).toContain("event = 'answer_submitted'");
    expect(String(evSql)).toContain('GROUP BY module');
    expect(evParams).toEqual([W.fromAt, W.toAt]);
    // 全局约束：聚合 SQL 一律 pool.query（LIMIT ? 与 execute 不兼容）
    expect(allSql(pool)).not.toContain('execute');
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(/);
  });
});
