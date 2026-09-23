import { describe, it, expect, vi } from 'vitest';
import {
  ALL_ERROR_SOURCES,
  ParentInsightsRepository,
  TRACK_SOURCES,
} from './parent-insights.repo.js';
import { UNCOVERED_ERROR_PREDICATE } from '../sql-fragments';

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
    // 与 MainErrorBooksRepository.countUncoveredUncleared 共用同一片段——这一行把「共用」本身钉死，
    // 否则将来把 NOT EXISTS 重新内联回查询，两边测试仍绿、漂移静默复活。
    expect(sql).toContain(UNCOVERED_ERROR_PREDICATE);
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

  it('MySQL 返回 Date 时按**本地**日期拼（toISOString 会在 UTC+8 下切到前一天）', async () => {
    const pool = mockPool([
      // mysql2 对 DATE 列返回本地零点的 Date：2026-09-15 本地零点
      { date: new Date(2026, 8, 15), answered: 10, correct: 7 },
    ]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getAccuracyTrend(9, new Date(2026, 8, 12), new Date(2026, 8, 19));

    expect(result[0].date).toBe('2026-09-15');
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

describe('ParentInsightsRepository：错题列表', () => {
  const listRows = [
    {
      id: 91, question_id: 330, subject_id: 1, source: 'exam', level: 2, is_cleared: 0,
      wrong_answer_text: 'x=3', created_at: new Date('2026-09-16T19:21:00Z'), cleared_at: null,
      question_content: '解方程', question_type: 'calculation', question_difficulty: 3,
    },
  ];

  it('返回 items + total；列表行与错题**一比一**（不 JOIN 知识点）', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([[{ count: 139 }], []]);
    pool.query.mockResolvedValueOnce([listRows, []]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.listParentErrors(9, {}, 20, 0);

    expect(result.total).toBe(139);
    expect(result.items).toEqual([
      {
        id: 91, questionId: 330, subjectId: 1, source: 'exam', level: 2, isCleared: false,
        wrongAnswerText: 'x=3', createdAt: listRows[0].created_at, clearedAt: null,
        questionContent: '解方程', questionType: 'calculation', questionDifficulty: 3,
      },
    ]);
    expect(pool.execute.mock.calls[0][0]).toContain('COUNT(*) AS count');
    // 列表走 query（LIMIT ?）
    const listSql = pool.query.mock.calls[0][0] as string;
    expect(listSql).toContain('LEFT JOIN questions');
    expect(listSql).toContain('ORDER BY meb.created_at DESC, meb.id DESC');
    // 关键：分页查询**不能**碰知识点关联表，否则一题多 KP 会把行翻倍、分页就错了
    expect(listSql).not.toContain('question_knowledge_points');
    expect(listSql).not.toContain('knowledge_points');
  });

  it('筛选条件逐条下推（学科 / source / 轨道 / 清零态 / 时间窗）', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    pool.query.mockResolvedValueOnce([[], []]);
    const repo = new ParentInsightsRepository(pool as any);

    await repo.listParentErrors(
      9,
      {
        subjectId: 1, source: 'exam', cleared: 'uncleared',
        from: '2026-09-01', to: '2026-09-18',
      },
      20,
      0,
    );

    const countSql = pool.execute.mock.calls[0][0] as string;
    expect(countSql).toContain('meb.subject_id = ?');
    expect(countSql).toContain('meb.source = ?');
    expect(countSql).toContain('meb.is_cleared = 0');
    expect(countSql).toContain('meb.created_at >= ?');
    expect(countSql).toContain('meb.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    expect(pool.execute.mock.calls[0][1]).toEqual([
      9, 1, 'exam', '2026-09-01', '2026-09-18',
    ]);
    // count 与 list 用的是同一份 WHERE
    expect(pool.query.mock.calls[0][0]).toContain('meb.subject_id = ?');
  });

  it('track 白名单由 TRACK_SOURCES 生成：main 不含 auxiliary，training 不含 exam', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    pool.query.mockResolvedValueOnce([[], []]);
    const repo = new ParentInsightsRepository(pool as any);

    await repo.listParentErrors(9, { track: 'main' }, 20, 0);
    const mainSql = pool.execute.mock.calls[0][0] as string;
    expect(mainSql).toContain('meb.source IN (?, ?, ?)');
    // 参数里的 source 列表必须与常量同源，不能是手抄的字面量
    expect(pool.execute.mock.calls[0][1]).toEqual([9, ...TRACK_SOURCES.main]);
    // 孩子问过的题（auxiliary）属训练档，不能出现在主线档
    expect(pool.execute.mock.calls[0][1]).not.toContain('auxiliary');

    pool.execute.mockClear();
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    await repo.listParentErrors(9, { track: 'training' }, 20, 0);
    expect(pool.execute.mock.calls[0][1]).toEqual([9, ...TRACK_SOURCES.training]);
    expect(pool.execute.mock.calls[0][1]).toContain('auxiliary');
    // 考试错题属主线档
    expect(pool.execute.mock.calls[0][1]).not.toContain('exam');
  });

  it('source 分区不重不漏：每个已知 source 恰好归某一档', () => {
    // 这条是 TRACK_SOURCES 的兜底：新增 source 只加进 main_error_books 却忘了登记档位，
    // 会让它在家长端两个档里都搜不到（只剩「全部」能看到）——这条必须红。
    const partitioned = [...TRACK_SOURCES.main, ...TRACK_SOURCES.training];
    expect([...partitioned].sort()).toEqual([...ALL_ERROR_SOURCES].sort());
    expect(new Set(partitioned).size).toBe(partitioned.length); // 无重复（一源一档）
  });

  it('cleared=cleared → is_cleared = 1；不传 → 不过滤清零态', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    pool.query.mockResolvedValueOnce([[], []]);
    const repo = new ParentInsightsRepository(pool as any);

    await repo.listParentErrors(9, { cleared: 'cleared' }, 20, 0);
    expect(pool.execute.mock.calls[0][0]).toContain('meb.is_cleared = 1');

    pool.execute.mockClear();
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    await repo.listParentErrors(9, {}, 20, 0);
    expect(pool.execute.mock.calls[0][0]).not.toContain('meb.is_cleared');
  });

  it('question_id 为 NULL 的行不炸（题目相关列全 null）', async () => {
    const pool = mockPool([
      {
        id: 5, question_id: null, subject_id: 1, source: 'practice', level: 1, is_cleared: 0,
        wrong_answer_text: '只会题面', created_at: new Date('2026-09-10T10:00:00Z'), cleared_at: null,
        question_content: null, question_type: null, question_difficulty: null,
      },
    ]);
    pool.execute.mockResolvedValueOnce([[{ count: 1 }], []]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.listParentErrors(9, {}, 20, 0);

    expect(result.items[0]).toMatchObject({
      questionId: null, questionContent: null, wrongAnswerText: '只会题面',
    });
  });
});

describe('ParentInsightsRepository：本页错题的知识点', () => {
  it('按 questionIds 批量取，一题多 KP 出多行', async () => {
    const pool = mockPool([
      { question_id: 330, knowledge_point_id: 42, knowledge_point_name: '分数加减' },
      { question_id: 330, knowledge_point_id: 43, knowledge_point_name: '整式' },
      { question_id: 331, knowledge_point_id: 44, knowledge_point_name: '方程' },
    ]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.listErrorKnowledgePoints([330, 331]);

    expect(result).toEqual([
      { questionId: 330, knowledgePointId: 42, knowledgePointName: '分数加减' },
      { questionId: 330, knowledgePointId: 43, knowledgePointName: '整式' },
      { questionId: 331, knowledgePointId: 44, knowledgePointName: '方程' },
    ]);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('question_knowledge_points');
    expect(sql).toContain('IN (?,?)');
    expect(pool.execute.mock.calls[0][1]).toEqual([330, 331]);
  });

  it('空数组 → 直接返回 []，**不发 SQL**（IN () 是语法错误）', async () => {
    const pool = mockPool([]);
    const repo = new ParentInsightsRepository(pool as any);

    expect(await repo.listErrorKnowledgePoints([])).toEqual([]);
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

describe('ParentInsightsRepository：会话列表', () => {
  const logRows = [
    {
      id: 55, track: 'auxiliary', scene: 'aux_qna', title: '二次函数求最值', subject_id: null,
      created_at: new Date('2026-09-16T10:00:00Z'), last_active_at: new Date('2026-09-16T10:05:00Z'),
      message_count: 8, block_count: 2,
    },
  ];

  it('带出 messageCount / blockCount（一条 JOIN 聚合，避免 N+1）', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([[{ count: 80 }], []]);
    pool.query.mockResolvedValueOnce([logRows, []]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.listParentChatLogs(9, {}, 20, 0);

    expect(result.total).toBe(80);
    expect(result.items[0]).toMatchObject({
      id: 55, track: 'auxiliary', scene: 'aux_qna', title: '二次函数求最值',
      subjectId: null, messageCount: 8, blockCount: 2,
    });
    // `updatedAt` 取的是「最后一条消息时间」（SQL 里的 last_active_at），不是 d.updated_at
    expect(result.items[0].updatedAt).toEqual(new Date('2026-09-16T10:05:00Z'));

    const listSql = pool.query.mock.calls[0][0] as string;
    expect(listSql).toContain('SUM(m.safety_flag = 1)');
    // 消息侧条件必须在 ON 里：写到 WHERE 会把 LEFT JOIN 变成 INNER JOIN，零消息会话会整条消失
    expect(listSql).toContain('LEFT JOIN ai_messages m');
    expect(listSql).toContain('m.deleted_at IS NULL');
    expect(listSql).toContain('d.deleted_at IS NULL');
    // 排序按「最后一条消息时间」——用 d.updated_at 会把横跨整个学期的主线卡片会话排错
    expect(listSql).toContain('COALESCE(MAX(m.created_at), d.created_at) AS last_active_at');
    expect(listSql).toContain('ORDER BY last_active_at DESC');
    // 会话行可能在几十毫秒内同时创建，没有 id 兜底 OFFSET 分页会漏行/重复行
    expect(listSql).toContain('d.id DESC');
  });

  it('筛选下推：轨道 / 场景 / 时间窗（按最后一条消息时间）/ 标题关键词', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    pool.query.mockResolvedValueOnce([[], []]);
    const repo = new ParentInsightsRepository(pool as any);

    await repo.listParentChatLogs(
      9,
      { track: 'auxiliary', scene: 'aux_qna', from: '2026-09-01', to: '2026-09-18', q: '函数' },
      20,
      0,
    );

    const countSql = pool.execute.mock.calls[0][0] as string;
    expect(countSql).toContain('d.track = ?');
    expect(countSql).toContain('d.scene = ?');
    // 时间窗走相关子查询（count 查询不带 JOIN，写聚合会报错；且 count/list 必须共用同一份 WHERE）
    expect(countSql).toContain('(SELECT MAX(m2.created_at) FROM ai_messages m2');
    expect(countSql).toContain('>= ?');
    expect(countSql).toContain('< DATE_ADD(?, INTERVAL 1 DAY)');
    expect(countSql).toContain('d.title LIKE ?');
    expect(pool.execute.mock.calls[0][1]).toEqual([
      9, 'auxiliary', 'aux_qna', '2026-09-01', '2026-09-18', '%函数%',
    ]);
  });

  it('关键词里的 % 与 _ 被转义，不当作通配符', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    pool.query.mockResolvedValueOnce([[], []]);
    const repo = new ParentInsightsRepository(pool as any);

    await repo.listParentChatLogs(9, { q: '50%_x' }, 20, 0);

    expect(pool.execute.mock.calls[0][1]).toEqual([9, '%50\\%\\_x%']);
  });
});
