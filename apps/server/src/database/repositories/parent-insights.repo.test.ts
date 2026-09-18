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

describe('ParentInsightsRepository：正确率（口径钉子）', () => {
  it('合并 practice_results 与 exam_answers；排除 unanswered/self_assess 与 is_correct IS NULL', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([
      [
        { subject_id: 1, answered: 42, correct: 31 },
        { subject_id: 2, answered: 10, correct: 4 },
      ],
      [],
    ]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getAccuracyBySubject(9);

    expect(result).toEqual([
      { subjectId: 1, answered: 42, correct: 31 },
      { subjectId: 2, answered: 10, correct: 4 },
    ]);

    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain("method IN ('exact','ai')");
    expect(sql).toContain("es.status = 'submitted'");
    expect(sql).toContain('ea.is_correct IS NOT NULL');
    // 不传窗口 → 无时间条件，参数只有两个 studentId
    expect(pool.execute.mock.calls[0][1]).toEqual([9, 9]);
  });

  it('传窗口 → 两个源各自带 judged_at 半开区间', async () => {
    const pool = mockPool([]);
    const from = new Date('2026-09-12T00:00:00Z');
    const to = new Date('2026-09-19T00:00:00Z');
    const repo = new ParentInsightsRepository(pool as any);

    await repo.getAccuracyBySubject(9, from, to);

    const sql = pool.execute.mock.calls[0][0] as string;
    // 两个源各出现一次窗口条件（practice 的 judged_at、exam 的 ea.judged_at）
    expect(sql.match(/judged_at >= \?/g)).toHaveLength(2);
    expect(sql).toContain('ea.judged_at < ?');
    expect(pool.execute.mock.calls[0][1]).toEqual([9, from, to, 9, from, to]);
  });

  it('answered 为 0 时原样返回（rate 的 null 判定在 util）', async () => {
    const pool = mockPool([{ subject_id: 1, answered: 0, correct: 0 }]);
    const repo = new ParentInsightsRepository(pool as any);
    expect(await repo.getAccuracyBySubject(9)).toEqual([
      { subjectId: 1, answered: 0, correct: 0 },
    ]);
  });
});

describe('ParentInsightsRepository：自评与考试场次', () => {
  it('自评全部计入 count、只有 correct 计入 correctCount', async () => {
    const pool = mockPool([{ subject_id: 1, count: 5, correct_count: 3 }]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getSelfAssessBySubject(9);

    expect(result).toEqual([{ subjectId: 1, count: 5, correctCount: 3 }]);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('FROM question_self_assessments');
    expect(sql).toContain("assessment = 'correct'");
  });

  it('考试场次按学科计数，只算已交卷', async () => {
    const pool = mockPool([{ subject_id: 1, count: 4 }]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getExamCounts(9);

    expect(result).toEqual([{ subjectId: 1, count: 4 }]);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'submitted'");
    expect(sql).toContain('GROUP BY subject_id');
  });
});

describe('ParentInsightsRepository：错题统计', () => {
  it('按学科出「未清零 / 总数」两个数（累计，不按时间窗）', async () => {
    const pool = mockPool([{ subject_id: 1, uncleared: 12, total: 20 }]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getErrorBookSummary(9);

    expect(result).toEqual([{ subjectId: 1, uncleared: 12, total: 20 }]);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('FROM main_error_books');
    expect(sql).toContain('SUM(is_cleared = 0)');
  });

  it('新增/清零各按 created_at / cleared_at 落窗', async () => {
    const pool = mockPool([]);
    pool.execute
      .mockResolvedValueOnce([[{ added: 6 }], []])
      .mockResolvedValueOnce([[{ cleared: 4 }], []]);
    const from = new Date('2026-09-12T00:00:00Z');
    const to = new Date('2026-09-19T00:00:00Z');
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getErrorDateCounts(9, from, to);

    expect(result).toEqual({ added: 6, cleared: 4 });
    expect(pool.execute.mock.calls[0][0]).toContain('created_at >= ?');
    expect(pool.execute.mock.calls[1][0]).toContain('cleared_at >= ?');
    expect(pool.execute.mock.calls[1][0]).toContain('is_cleared = 1');
  });

  it('薄弱点按未清零数降序、按 limit 截断（LIMIT 走 query，不走 execute）', async () => {
    const pool = mockPool([
      { knowledge_point_id: 42, name: '分数加减', uncleared_count: 3, total_wrong_count: 5 },
    ]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getWeakPoints(9, 10);

    expect(result).toEqual([
      { knowledgePointId: 42, name: '分数加减', unclearedCount: 3, totalWrongCount: 5 },
    ]);
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('JOIN question_knowledge_points');
    expect(sql).toContain('JOIN knowledge_points');
    expect(sql).toContain('ORDER BY uncleared_count DESC');
    expect(pool.query.mock.calls[0][1]).toEqual([9, 10]);
    // LIMIT 场景绝不能用 execute（服务端预处理会报 mysqld_stmt_execute）
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('未标注知识点的未清零错题单独计数', async () => {
    const pool = mockPool([{ uncovered: 8 }]);
    const repo = new ParentInsightsRepository(pool as any);

    expect(await repo.countUncoveredUnclearedErrors(9)).toBe(8);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('is_cleared = 0');
  });
});

describe('ParentInsightsRepository：趋势与考试列表', () => {
  it('趋势按日聚合，只含有记录的天（不补零，由前端铺 X 轴）', async () => {
    const pool = mockPool([
      { date: '2026-09-15', answered: 10, correct: 7 },
      { date: '2026-09-17', answered: 4, correct: 4 },
    ]);
    const repo = new ParentInsightsRepository(pool as any);
    const from = new Date('2026-09-12T00:00:00Z');
    const to = new Date('2026-09-19T00:00:00Z');

    const result = await repo.getAccuracyTrend(9, from, to);

    expect(result).toEqual([
      { date: '2026-09-15', answered: 10, correct: 7 },
      { date: '2026-09-17', answered: 4, correct: 4 },
    ]);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('DATE(judged_at)');
    // 与 getAccuracyBySubject 同口径（两源合并、排除未答/自评/未判）
    expect(sql).toContain("method IN ('exact','ai')");
    expect(sql).toContain('ea.is_correct IS NOT NULL');
    expect(sql).toContain('ORDER BY date ASC');
  });

  it('考试列表只取已交卷、按交卷时间倒序、带卷名与客观题数', async () => {
    const pool = mockPool([
      {
        session_id: 7,
        paper_title: '2025 学年七年级上期中',
        subject_id: 1,
        submitted_at: new Date('2026-09-16T19:20:00Z'),
        correct_count: 18,
        objective_count: 22,
      },
    ]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.listSubmittedExams(9, 20);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sessionId: 7,
      paperTitle: '2025 学年七年级上期中',
      subjectId: 1,
      correctCount: 18,
      objectiveCount: 22,
    });
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('JOIN exam_papers');
    expect(sql).toContain("status = 'submitted'");
    expect(sql).toContain('ORDER BY es.submitted_at DESC');
  });
});
