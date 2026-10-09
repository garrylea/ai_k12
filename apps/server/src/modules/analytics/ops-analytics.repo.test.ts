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

describe('OpsAnalyticsRepository — Task 10（retention / devices / cohort-compare 数据面）', () => {
  it('retentionCohort：cohort = 首活跃日 MIN(DATE(started_at)) = cohortStart 的学生', async () => {
    const pool = poolWithQueries([[{ student_id: 1 }, { student_id: 2 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const ids = await repo.retentionCohort('2026-10-01');
    expect(ids).toEqual([1, 2]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('MIN(DATE(started_at))');
    expect(String(sql)).toContain('HAVING first_day = ?');
    expect(params).toEqual(['2026-10-01']);
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(/);
  });

  it('retentionDay：cohort 限定的当日人头数；日边界应用层传参（无 CURDATE/NOW/DATE_ADD）', async () => {
    const pool = poolWithQueries([[{ retained: 1 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const retained = await repo.retentionDay([1, 2, 3], '2026-10-02 00:00:00', '2026-10-03 00:00:00');
    expect(retained).toBe(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('COUNT(DISTINCT student_id)');
    expect(String(sql)).toContain('student_id IN (?)');
    expect(params).toEqual([[1, 2, 3], '2026-10-02 00:00:00', '2026-10-03 00:00:00']);
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(|DATE_ADD/);
  });

  it('deviceDistributions：五维各一条 GROUP BY 按人头去重；窗口参数化、无 LIMIT', async () => {
    const pool = poolWithQueries([
      [{ k: 'ipad', students: 5, seconds: 6000, sessions: 9 }],
      [], [], [], [],
    ]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.deviceDistributions(W);
    expect(r.platform_class).toEqual([{ key: 'ipad', students: 5, seconds: 6000, sessions: 9 }]);
    expect(r.browser).toEqual([]);
    expect(pool.query).toHaveBeenCalledTimes(5);
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('COUNT(DISTINCT student_id)');
    expect(String(sql)).not.toContain('COUNT(student_id)'); // 防手滑：不许按会话计人头
    expect(String(sql)).toContain('platform_class IS NOT NULL');
    expect(String(sql)).toContain('GROUP BY platform_class');
    expect(params).toEqual([W.fromAt, W.toAt]);
    expect(allSql(pool)).not.toContain('LIMIT');
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(/);
  });

  it('answersByOutcome(module)：behavior_events 原生 module 列直接 GROUP BY', async () => {
    const pool = poolWithQueries([[{ k: 'mainline', students: 3, answered: 8, correct: 5 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.answersByOutcome(W, 'module');
    expect(r).toEqual([{ key: 'mainline', students: 3, answered: 8, correct: 5 }]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('FROM behavior_events');
    expect(String(sql)).toContain('module IS NOT NULL');
    expect(String(sql)).toContain("event = 'answer_submitted'");
    expect(String(sql)).toContain("props->>'$.verdict' = 'correct'");
    expect(String(sql)).not.toContain('JOIN');
    expect(params).toEqual([W.fromAt, W.toAt]);
  });

  it('answersByOutcome(设备列)：按「用过该设备类的学生」近似关联答题（DISTINCT 学生×设备列 JOIN）', async () => {
    const pool = poolWithQueries([[{ k: 'ipad', students: 3, answered: 8, correct: 5 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.answersByOutcome(W, 'platform_class');
    expect(r).toEqual([{ key: 'ipad', students: 3, answered: 8, correct: 5 }]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('JOIN (SELECT DISTINCT student_id, platform_class AS k');
    expect(String(sql)).toContain('ON p.student_id = be.student_id');
    expect(String(sql)).toContain("be.event = 'answer_submitted'");
    expect(params).toEqual([W.fromAt, W.toAt, W.fromAt, W.toAt]);
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(/);
  });

  it('sessionsByOutcome：时长侧按列分组；daysActive 的去重日按「学生×日期」计', async () => {
    const pool = poolWithQueries([[{ k: 'ipad', students: 5, seconds: 6000, student_days: 12 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.sessionsByOutcome(W, 'platform_class');
    expect(r).toEqual([{ key: 'ipad', students: 5, seconds: 6000, studentDays: 12 }]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('COUNT(DISTINCT student_id, DATE(started_at))');
    expect(String(sql)).toContain('SUM(active_seconds)');
    expect(String(sql)).toContain('GROUP BY platform_class');
    expect(params).toEqual([W.fromAt, W.toAt]);
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(/);
  });

  it('multiDevice：HAVING cnt > 1 分档按人头，档位升序', async () => {
    const pool = poolWithQueries([[{ cnt: 2, students: 3 }, { cnt: 3, students: 1 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.multiDevice(W);
    expect(r).toEqual([{ count: 2, students: 3 }, { count: 3, students: 1 }]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('COUNT(DISTINCT platform_class)');
    expect(String(sql)).toContain('HAVING cnt > 1');
    expect(params).toEqual([W.fromAt, W.toAt]);
  });

  it('switches：相邻会话（s2 = 之后最早一列）平台不同即切换，按人头去重', async () => {
    const pool = poolWithQueries([[{ cnt: 7, students: 4 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.switches(W);
    expect(r).toEqual({ count: 7, students: 4 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('COUNT(DISTINCT s1.student_id)');
    expect(String(sql)).toContain('MIN(m.id)');
    expect(String(sql)).toContain('s2.started_at > s1.started_at');
    expect(String(sql)).toContain('s1.platform_class <> s2.platform_class');
    expect(params).toEqual([W.fromAt, W.toAt]);
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(/);
  });
});

describe('OpsAnalyticsRepository — Task 11（quality / llm-tokens / llm-calls / requests 数据面）', () => {
  it('llmTokenGroups(scene)：unavailable 单列（CASE WHEN usage_source <> unavailable），窗口参数化', async () => {
    const pool = poolWithQueries([
      [{ grp: 'tutoring', calls: 3, input_tokens: 100, output_tokens: 0, unavailable_calls: 1 }],
    ]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.llmTokenGroups(W, 'scene');
    expect(r).toEqual([
      { key: 'tutoring', calls: 3, inputTokens: 100, outputTokens: 0, unavailableCalls: 1 },
    ]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('FROM llm_call_logs');
    expect(String(sql)).toContain("CASE WHEN usage_source <> 'unavailable' THEN input_tokens END");
    expect(String(sql)).toContain("CASE WHEN usage_source <> 'unavailable' THEN output_tokens END");
    expect(String(sql)).toContain("SUM(usage_source = 'unavailable')");
    expect(String(sql)).toContain('GROUP BY scene');
    expect(String(sql)).toContain('ORDER BY calls DESC');
    expect(params).toEqual([W.fromAt, W.toAt]);
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(/);
  });

  it('llmTokenGroups(model)：聚合键是 model_key，绝不用 model_id；day 用 DATE_FORMAT 防时区漂移', async () => {
    const pool = poolWithQueries([[], []]);
    const repo = new OpsAnalyticsRepository(pool);
    await repo.llmTokenGroups(W, 'model');
    await repo.llmTokenGroups(W, 'day');
    const [modelSql] = pool.query.mock.calls[0];
    expect(String(modelSql)).toContain('model_key');
    expect(String(modelSql)).not.toContain('model_id');
    expect(String(modelSql)).toContain('GROUP BY model_key');
    const [daySql] = pool.query.mock.calls[1];
    expect(String(daySql)).toContain("DATE_FORMAT(created_at, '%Y-%m-%d')");
  });

  it('llmTokenGroups：groupBy 越界（白名单外）直接拒绝，不发 SQL', async () => {
    const pool = poolWithQueries([]);
    const repo = new OpsAnalyticsRepository(pool);
    await expect(repo.llmTokenGroups(W, 'cost' as never)).rejects.toThrow();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('llmTokensOverview：attributed/unattributed/unavailableCalls 一条总览', async () => {
    const pool = poolWithQueries([[{ attributed: 7, unattributed: 2, unavailable_calls: 3 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.llmTokensOverview(W);
    expect(r).toEqual({ attributed: 7, unattributed: 2, unavailableCalls: 3 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('SUM(student_id IS NOT NULL)');
    expect(String(sql)).toContain('SUM(student_id IS NULL)');
    expect(String(sql)).toContain("SUM(usage_source = 'unavailable')");
    expect(params).toEqual([W.fromAt, W.toAt]);
  });

  it('qualityApi：失败口径 = status_code>=500 或 COALESCE(biz_code,5000)<>0（5000 与 filter 默认码一致）', async () => {
    const pool = poolWithQueries([[{ total: 100, failures: 8 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.qualityApi(W);
    expect(r).toEqual({ total: 100, failures: 8 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('FROM api_request_logs');
    expect(String(sql)).toContain('status_code >= 500');
    expect(String(sql)).toContain('COALESCE(biz_code, 5000) <> 0');
    expect(params).toEqual([W.fromAt, W.toAt]);
  });

  it('qualityErrorCodes：只统计失败行，按 COALESCE(biz_code,5000) 分组', async () => {
    const pool = poolWithQueries([[{ code: 5000, cnt: 5 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.qualityErrorCodes(W);
    expect(r).toEqual([{ code: 5000, count: 5 }]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('COALESCE(biz_code, 5000) AS code');
    expect(String(sql)).toContain('status_code >= 500');
    expect(String(sql)).toContain('GROUP BY code');
    expect(params).toEqual([W.fromAt, W.toAt]);
  });

  it('qualityLlm：超时口径 = error_type = TimeoutError（llm_call_logs 实际列），fallback/归因同表', async () => {
    const pool = poolWithQueries([[{ calls: 50, timeouts: 2, fallbacks: 3, attributed: 45 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.qualityLlm(W);
    expect(r).toEqual({ calls: 50, timeouts: 2, fallbacks: 3, attributed: 45 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain("error_type = 'TimeoutError'");
    expect(String(sql)).toContain('SUM(is_fallback)');
    expect(String(sql)).toContain('SUM(student_id IS NOT NULL)');
    expect(params).toEqual([W.fromAt, W.toAt]);
  });

  it('contentQuality：内容库三查无窗口参数（questions 无标准答案 / kp 覆盖 / english_words 错次）', async () => {
    const pool = poolWithQueries([
      [{ cnt: 4 }],
      [{ total: 100, covered: 90 }],
      [{ wrong: 30, total: 600 }],
    ]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.contentQuality();
    expect(r).toEqual({
      questionsWithoutStandardAnswer: 4, kpCovered: 90, kpTotal: 100, wordWrong: 30, wordTotal: 600,
    });
    expect(pool.query).toHaveBeenCalledTimes(3);
    const [qSql] = pool.query.mock.calls[0];
    expect(String(qSql)).toContain('FROM questions');
    expect(String(qSql)).toContain("TRIM(answer) = ''");
    const [kpSql] = pool.query.mock.calls[1];
    expect(String(kpSql)).toContain('question_knowledge_points');
    expect(String(kpSql)).toContain('EXISTS');
    const [wSql] = pool.query.mock.calls[2];
    expect(String(wSql)).toContain('FROM english_words');
    expect(String(wSql)).toContain('SUM(error_count)');
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(/);
  });

  it('llmCallsPage：动态条件只在给出时拼，LIMIT ?/OFFSET ? 参数化且走 pool.query', async () => {
    const pool = poolWithQueries([[{ total: 41 }], [{ id: 9 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.llmCallsPage({
      scene: 'tutoring', model: 'qwen-max', success: 0, offset: 40, limit: 20,
    });
    expect(r).toEqual({ rows: [{ id: 9 }], total: 41 });
    const [countSql, countParams] = pool.query.mock.calls[0];
    expect(String(countSql)).toContain('COUNT(*)');
    expect(String(countSql)).toContain('scene = ?');
    expect(String(countSql)).toContain('model_key = ?');
    expect(String(countSql)).toContain('success = ?');
    expect(countParams).toEqual(['tutoring', 'qwen-max', 0]);
    const [rowsSql, rowsParams] = pool.query.mock.calls[1];
    expect(String(rowsSql)).toContain('ORDER BY created_at DESC, id DESC');
    expect(String(rowsSql)).toContain('LIMIT ?');
    expect(String(rowsSql)).toContain('OFFSET ?');
    expect(rowsParams).toEqual(['tutoring', 'qwen-max', 0, 20, 40]);
    expect(allSql(pool)).not.toContain('execute');
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(/);
  });

  it('llmCallsPage：无过滤条件时不拼 WHERE', async () => {
    const pool = poolWithQueries([[{ total: 0 }], []]);
    const repo = new OpsAnalyticsRepository(pool);
    await repo.llmCallsPage({ offset: 0, limit: 20 });
    const [countSql, countParams] = pool.query.mock.calls[0];
    expect(String(countSql)).not.toContain('WHERE');
    expect(countParams).toEqual([]);
    expect(pool.query.mock.calls[1][1]).toEqual([20, 0]);
  });

  it('requestsPage：route LIKE %path%、status_code = ?、latency_ms >= ?，LIMIT ?/OFFSET ? 参数化', async () => {
    const pool = poolWithQueries([[{ total: 7 }], [{ id: 2 }]]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.requestsPage({
      path: '/api/practice', status: 500, minLatency: 1000, offset: 20, limit: 20,
    });
    expect(r).toEqual({ rows: [{ id: 2 }], total: 7 });
    const [countSql, countParams] = pool.query.mock.calls[0];
    expect(String(countSql)).toContain('route LIKE ?');
    expect(String(countSql)).toContain('status_code = ?');
    expect(String(countSql)).toContain('latency_ms >= ?');
    expect(countParams).toEqual(['%/api/practice%', 500, 1000]);
    const [rowsSql, rowsParams] = pool.query.mock.calls[1];
    expect(String(rowsSql)).toContain('ORDER BY created_at DESC, id DESC');
    expect(String(rowsSql)).toContain('LIMIT ?');
    expect(rowsParams).toEqual(['%/api/practice%', 500, 1000, 20, 20]);
    expect(allSql(pool)).not.toMatch(/CURDATE|NOW\(/);
  });
});
