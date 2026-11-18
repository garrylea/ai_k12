import { describe, it, expect, vi } from 'vitest';
import { QuestionsRepository } from './questions.repo';

/** mockPool：SELECT 一律返回 rows（main-error-books.repo.test.ts 同款形状）。
 *  findRandomByKpAndType 用 pool.query（LIMIT ? 不能走 prepared statement，
 *  联调实测 mysql2 execute 报 Incorrect arguments to mysqld_stmt_execute）。 */
const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([[], []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('QuestionsRepository.findRandomByKpAndType', () => {
  it('SQL 含 LEFT JOIN student_hidden_questions / JOIN qkp / 空答案过滤 / RAND() / LIMIT ?，type 非空时带题型过滤', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findRandomByKpAndType(7, 1, 3, 'proof', 5);
    expect(pool.execute).not.toHaveBeenCalled();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('JOIN question_knowledge_points qkp');
    expect(sql).toContain('LEFT JOIN student_hidden_questions shq');
    expect(sql).toContain('shq.question_id = q.id AND shq.student_id = ?');
    expect(sql).toContain('shq.id IS NULL');
    expect(sql).toContain('qkp.knowledge_point_id = ?');
    expect(sql).toContain('q.subject_id = ?');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain('q.type = ?');
    // 判题体系重构 2026-09-09：空答案题一律排除
    expect(sql).toContain("q.answer <> ''");
    expect(sql).toContain('RAND()');
    expect(sql).toContain('LIMIT ?');
    // 卷内题号：作答页展示「来源 + 试卷第 N 题」，多卷题优先取 source 对应的那份卷
    expect(sql).toContain('paper_questions pq');
    expect(sql).toContain('AS question_no');
    // 老批量导入题没有 paper_questions 关联，退回 questions.group_order（卷面题号）
    expect(sql).toContain('COALESCE(');
    expect(sql).toContain('q.group_order');
    expect(params).toEqual([7, 1, 3, 'proof', 5]);
  });

  it('findRandomByKpAndType：空答案题全题型排除（q.answer <> \'\'）', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findRandomByKpAndType(7, 1, 5, null, 10);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("q.answer <> ''");
    expect(sql).not.toContain('NOT (q.type IN');
  });

  it('type=null 时 SQL 不含题型过滤，参数省略 type', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findRandomByKpAndType(7, 1, 3, null, 10);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('q.type = ?');
    expect(params).toEqual([7, 1, 3, 10]);
  });

  it('返回 QuestionRow 行', async () => {
    const row = { id: 10, type: 'choice', content: '题面', answer: 'A' };
    const repo = new QuestionsRepository(mockPool([row]) as any);
    const rows = await repo.findRandomByKpAndType(7, 1, 3, null, 5);
    expect(rows).toEqual([row]);
  });
});

describe('QuestionsRepository.findKpIdsByQuestionIds', () => {
  it('空入参直接返回空 Map，不查库', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    expect(await repo.findKpIdsByQuestionIds([])).toEqual(new Map());
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('SQL 按 primary 优先 + kp id 升序取每题首个 KP', async () => {
    const pool = mockPool([
      { question_id: 100, knowledge_point_id: 28 },
      { question_id: 100, knowledge_point_id: 3 }, // 同题重复行只取首个
      { question_id: 200, knowledge_point_id: 9 },
    ]);
    const repo = new QuestionsRepository(pool as any);
    const map = await repo.findKpIdsByQuestionIds([100, 200]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('FROM question_knowledge_points');
    expect(sql).toContain('(role = \'primary\') DESC');
    expect(sql).toContain('ORDER BY question_id');
    expect(params).toEqual([100, 200]);
    expect(map.get(100)).toBe(28);
    expect(map.get(200)).toBe(9);
  });
});

describe('QuestionsRepository.findRandomByKpTypeDifficulty', () => {
  it('难度数组为空：直接返回 []，不发 SQL（避免 IN () 语法错误 → 500）', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    expect(await repo.findRandomByKpTypeDifficulty(7, 1, 3, 'choice', [], 5, [])).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('正常难度数组：IN (?,?) 与参数顺序正确（含排除 id 与 LIMIT）', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findRandomByKpTypeDifficulty(7, 1, 3, 'choice', [1, 3], 5, [100, 201]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('q.difficulty IN (?,?)');
    expect(sql).toContain('q.id NOT IN (?,?)');
    expect(params).toEqual([7, 1, 3, 'choice', 1, 3, 100, 201, 5]);
  });

  it('requireAllKpRootCodes：追加 EXISTS + NOT EXISTS，参数顺序在排除 id 之前', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findRandomByKpTypeDifficulty(7, 2, 104, 'choice', [2], 3, [100], {
      requireAllKpRootCodes: ['C01', 'C02'],
    });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('COALESCE(pk2.code, kp2.code) IN (?,?)');
    expect(sql).toContain('COALESCE(pk3.code, kp3.code) NOT IN (?,?)');
    expect(params).toEqual([7, 2, 104, 'choice', 2, 'C01', 'C02', 'C01', 'C02', 100, 3]);
  });
});

describe('QuestionsRepository.updateExplanation', () => {
  it('执行 UPDATE questions SET explanation = ? WHERE id = ? 回写解析缓存', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.updateExplanation(1, '标准题解');
    expect(pool.query).not.toHaveBeenCalled();
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toBe('UPDATE questions SET explanation = ? WHERE id = ?');
    expect(params).toEqual(['标准题解', 1]);
  });
});

describe('QuestionsRepository.createFreeform', () => {
  const row = {
    subject_id: 1,
    type: 'solution',
    difficulty: 3,
    full_score: 10,
    content: '已知 ![图](/uploads/a.png) 求 x',
    options: null,
    answer: 'x=1',
    approach: null,
    explanation: null,
    source: 'freeform' as const,
    content_hash: 'abc123',
  };

  it('写入 full_score 且 answer_verified=0 / is_active=1', async () => {
    const pool = {
      execute: vi.fn().mockResolvedValue([{ insertId: 7 }, []]),
      query: vi.fn(),
    };
    const repo = new QuestionsRepository(pool as any);
    const id = await repo.createFreeform(row);
    expect(id).toBe(7);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('full_score');
    expect(sql).toContain('answer_verified');
    expect(sql).toContain('is_active');
    // 字面量值断言：answer_verified=0、is_active=1（列名存在但值改成 1/0 要被抓住）
    expect(sql).toMatch(/,\s*0,\s*1\)\s*$/);
    expect(params).toContain(10);
    // 列数 = 占位符数：11 个 ? + 字面量 0/1
    expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
    expect(params).toEqual([
      1, 'solution', 3, 10, row.content, null, 'x=1', null, null, 'freeform', 'abc123',
    ]);
  });

  it('并发相同 content_hash 撞 UNIQUE：捕获 ER_DUP_ENTRY 并返回既有行 id', async () => {
    const dup = Object.assign(new Error('Duplicate entry'), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
    });
    const pool = {
      // 第 1 次是 INSERT（撞唯一键），第 2 次是 findByContentHash 的 SELECT
      execute: vi
        .fn()
        .mockRejectedValueOnce(dup)
        .mockResolvedValueOnce([[{ id: 99, content_hash: 'abc123' }], []]),
      query: vi.fn(),
    };
    const repo = new QuestionsRepository(pool as any);
    await expect(repo.createFreeform(row)).resolves.toBe(99);
    const [selectSql, selectParams] = pool.execute.mock.calls[1];
    expect(selectSql).toContain('FROM questions WHERE content_hash = ?');
    expect(selectParams).toEqual(['abc123']);
  });
});

describe('QuestionsRepository.updateFreeform', () => {
  it('按 id + source=freeform 限定更新，占位符与参数对齐', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{}, []]), query: vi.fn() };
    const repo = new QuestionsRepository(pool as any);
    await repo.updateFreeform(7, {
      type: 'solution',
      difficulty: 3,
      full_score: 10,
      content: '题面',
      options: null,
      answer: 'x=1',
      approach: null,
      explanation: null,
      content_hash: 'abc123',
    });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain("WHERE id=? AND source='freeform'");
    expect(sql).toContain('full_score=?');
    expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
    expect(params).toEqual(['solution', 3, 10, '题面', null, 'x=1', null, null, 'abc123', 7]);
  });
});

describe('QuestionsRepository 模型专项抽题', () => {
  it('count：JOIN 标签 / confidence>=0.70 / active / 有答案 / 隐藏排除', async () => {
    const pool = mockPool([{ count: 2 }]);
    const repo = new QuestionsRepository(pool as any);
    const n = await repo.countModelSpecialQuestions(7, 1, 'geometry_synthesis', 'median_doubling');
    expect(n).toBe(2);
    expect(pool.execute).not.toHaveBeenCalled();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('JOIN question_model_tags qmt');
    expect(sql).toContain('qmt.confidence >= 0.70');
    expect(sql).toContain('LEFT JOIN student_hidden_questions shq');
    expect(sql).toContain('shq.id IS NULL');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain("q.answer <> ''");
    expect(params).toEqual([7, 1, 'geometry_synthesis', 'median_doubling']);
  });

  it('find：倍长中线固定 id 升序；其他模型随机', async () => {
    const pool = mockPool([{ id: 7093 }, { id: 7094 }]);
    const repo = new QuestionsRepository(pool as any);
    const rows = await repo.findModelSpecialQuestions(
      7, 1, 'geometry_synthesis', 'median_doubling', 2,
    );
    expect(rows.map((r) => r.id)).toEqual([7093, 7094]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('ORDER BY q.id ASC LIMIT ?');
    expect(sql).toContain('AS question_no');
    expect(params).toEqual([7, 1, 'geometry_synthesis', 'median_doubling', 2]);

    const pool2 = mockPool([{ id: 1 }]);
    const repo2 = new QuestionsRepository(pool2 as any);
    await repo2.findModelSpecialQuestions(7, 1, 'geometry_synthesis', 'hand_in_hand', 3);
    expect(pool2.query.mock.calls[0][0]).toContain('ORDER BY RAND() LIMIT ?');
  });
});

describe('QuestionsRepository.findKpRefsByQuestionIds', () => {
  it('按题聚合知识点并带顶层 code', async () => {
    const pool = mockPool([
      { question_id: 100, id: 88, root_code: 'C01' },
      { question_id: 100, id: 109, root_code: 'C03' },
      { question_id: 200, id: 104, root_code: 'C02' },
    ]);
    const repo = new QuestionsRepository(pool as any);
    const map = await repo.findKpRefsByQuestionIds([100, 200]);
    expect(map.get(100)).toEqual([
      { id: 88, rootCode: 'C01' },
      { id: 109, rootCode: 'C03' },
    ]);
    expect(map.get(200)).toEqual([{ id: 104, rootCode: 'C02' }]);
  });

  it('空入参不发 SQL', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    expect(await repo.findKpRefsByQuestionIds([])).toEqual(new Map());
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('SQL 用父级 code 兜底自身 code', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findKpRefsByQuestionIds([1]);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('COALESCE(pk.code, kp.code) AS root_code');
    expect(sql).toContain('LEFT JOIN knowledge_points pk ON pk.id = kp.parent_kp_id');
  });
});

describe('QuestionsRepository — 试卷题号', () => {
  const optionsRow = { grade: '初三', semester: 'first', question_count: 28, papers: 5 };

  it('listPaperPositionOptions：按 grade/semester/question_count 分组，只统计可判题', async () => {
    const pool = mockPool([optionsRow]);
    const repo = new QuestionsRepository(pool as any);
    const rows = await repo.listPaperPositionOptions(1);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('COUNT(DISTINCT p.id) AS papers');
    expect(sql).toContain("p.semester IN ('first', 'second')");
    expect(sql).toContain('GROUP BY p.grade, p.semester, p.question_count');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain("q.answer <> ''");
    expect(params).toEqual([1]);
    expect(rows).toEqual([optionsRow]);
  });

  it('countPaperPositionQuestions：三张作答表都参与「从未做过」判定', async () => {
    const pool = mockPool([{ question_no: 24, total: 6, wrong_count: 2, untried_count: 3 }]);
    const repo = new QuestionsRepository(pool as any);
    const rows = await repo.countPaperPositionQuestions(7, 1, '初三', 'first');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('COUNT(DISTINCT CASE WHEN EXISTS (');
    expect(sql).toContain('FROM main_error_books meb');
    expect(sql).toContain('meb.is_cleared = 0');
    expect(sql).toContain('FROM special_answer_records sar');
    expect(sql).toContain('JOIN special_practice_sessions sps');
    expect(sql).toContain('FROM exam_answers ea');
    expect(sql).toContain('JOIN exam_sessions es');
    expect(sql).toContain('FROM practice_results pr');
    // 主线跳过未答（method='unanswered'）只是占位行，不算「做过」
    expect(sql).toContain("pr.method <> 'unanswered'");
    expect(sql).toContain('sar.is_correct IS NOT NULL');
    expect(sql).toContain('ea.is_correct IS NOT NULL');
    expect(sql).toContain('FROM student_hidden_questions shq');
    expect(sql).toContain('GROUP BY pq.question_no');
    expect(params).toEqual([7, 1, 7, 1, 7, 7, 7, 1, '初三', 'first', 7, 1]);
    expect(rows[0].wrong_count).toBe(2);
  });

  it('findPaperPositionWrongQuestions：JOIN 未清错题本 + level 降序 + LIMIT ?', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findPaperPositionWrongQuestions(7, 1, '初三', 'first', 24, 3);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('JOIN main_error_books meb');
    expect(sql).toContain('meb.is_cleared = 0');
    expect(sql).toContain('MIN(pq.question_no) AS question_no');
    expect(sql).toContain('GROUP BY q.id');
    expect(sql).toContain('ORDER BY wrong_level DESC, last_wrong_at DESC, q.id ASC');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual([7, 1, 1, '初三', 'first', 24, 7, 1, 3]);
  });

  it('findPaperPositionUntriedQuestions：排除三张作答表 + 错题本 + hidden', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findPaperPositionUntriedQuestions(7, 1, '初三', 'first', 24, 2);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('NOT EXISTS (');
    expect(sql).toContain('FROM special_answer_records sar');
    expect(sql).toContain('FROM exam_answers ea');
    expect(sql).toContain('FROM practice_results pr');
    // 主线跳过未答（method='unanswered'）只是占位行，不算「做过」
    expect(sql).toContain("pr.method <> 'unanswered'");
    expect(sql).toContain('FROM main_error_books meb');
    expect(sql).toContain('FROM student_hidden_questions shq');
    expect(sql).toContain('ORDER BY q.id ASC');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual([1, '初三', 'first', 24, 7, 1, 7, 1, 7, 7, 7, 2]);
  });
});
