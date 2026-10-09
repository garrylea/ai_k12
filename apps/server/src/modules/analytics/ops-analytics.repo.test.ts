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

  it('funnel：每步独立条件（OR 组）按事件去重到人；mainline 第三步走 ★裁决过滤', async () => {
    const pool = poolWithQueries([
      [
        { event: 'study_session_started', students: 100 },
        { event: 'answer_submitted', students: 60 },
        { event: 'points_awarded', students: 30 },
      ],
    ]);
    const repo = new OpsAnalyticsRepository(pool);
    const steps = [
      { event: 'study_session_started', extraWhere: 'module = ?', extraParams: ['mainline'] },
      { event: 'answer_submitted', extraWhere: 'module = ?', extraParams: ['mainline'] },
      {
        event: 'points_awarded',
        extraWhere: "module IS NULL AND props->>'$.taskCode' = ?",
        extraParams: ['mainline_lesson'],
      },
    ];
    const counts = await repo.funnel(W, steps);
    expect(counts.get('study_session_started')).toBe(100);
    expect(counts.get('answer_submitted')).toBe(60);
    expect(counts.get('points_awarded')).toBe(30);

    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('COUNT(DISTINCT student_id)');
    expect(String(sql)).toContain('GROUP BY event');
    // ★裁决：mainline 第三步 = points_awarded 且 module IS NULL 且完课 taskCode
    expect(String(sql)).toContain("module IS NULL AND props->>'$.taskCode' = ?");
    // 每步条件拼占位符（event=? + 额外条件），不插值用户输入
    expect(params).toEqual([
      W.fromAt, W.toAt,
      'study_session_started', 'mainline',
      'answer_submitted', 'mainline',
      'points_awarded', 'mainline_lesson',
    ]);
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(/);
  });

  it('funnel：窗口内无任何行 → 空 Map（步骤补 0 由 service 负责）', async () => {
    const pool = poolWithQueries([[]]);
    const repo = new OpsAnalyticsRepository(pool);
    const counts = await repo.funnel(W, [
      { event: 'study_session_started', extraWhere: 'module = ?', extraParams: ['exam'] },
    ]);
    expect(counts.size).toBe(0);
  });

  it('eventsPage：COUNT + SELECT 两条 SQL，动态条件只在给出时拼，LIMIT ?/OFFSET ? 参数化', async () => {
    const pool = poolWithQueries([[{ total: 41 }], [{ id: 9, event: 'page_view' }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.eventsPage({
      event: 'page_view', module: 'mainline',
      fromAt: W.fromAt, toAt: W.toAt, offset: 40, limit: 20,
    });
    expect(r).toEqual({ rows: [{ id: 9, event: 'page_view' }], total: 41 });

    const [countSql, countParams] = pool.query.mock.calls[0];
    expect(String(countSql)).toContain('COUNT(*)');
    expect(String(countSql)).toContain('event = ?');
    expect(String(countSql)).toContain('module = ?');
    expect(countParams).toEqual([W.fromAt, W.toAt, 'page_view', 'mainline']);

    const [rowsSql, rowsParams] = pool.query.mock.calls[1];
    expect(String(rowsSql)).toContain('ORDER BY created_at DESC, id DESC');
    expect(String(rowsSql)).toContain('LIMIT ?');
    expect(String(rowsSql)).toContain('OFFSET ?');
    expect(rowsParams).toEqual([W.fromAt, W.toAt, 'page_view', 'mainline', 20, 40]);
  });

  it('eventsPage：不过滤 tier（全部 tier），event/module 缺省时不拼对应条件', async () => {
    const pool = poolWithQueries([[{ total: 3 }], []]);
    const repo = new OpsAnalyticsRepository(pool);
    await repo.eventsPage({ fromAt: W.fromAt, toAt: W.toAt, offset: 0, limit: 20 });

    const [countSql, countParams] = pool.query.mock.calls[0];
    expect(String(countSql)).not.toContain('tier');
    expect(String(countSql)).not.toContain('event = ?');
    expect(String(countSql)).not.toContain('module = ?');
    expect(countParams).toEqual([W.fromAt, W.toAt]);

    const [rowsSql, rowsParams] = pool.query.mock.calls[1];
    expect(String(rowsSql)).toContain('LIMIT ?');
    expect(rowsParams).toEqual([W.fromAt, W.toAt, 20, 0]);
    // 全局约束：聚合/分页 SQL 一律 pool.query（LIMIT ? 与 execute 不兼容）
    expect(allSql(pool)).not.toContain('execute');
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(/);
  });
});
