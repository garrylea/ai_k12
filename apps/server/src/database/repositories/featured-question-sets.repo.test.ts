import { describe, it, expect, vi } from 'vitest';
import { FeaturedQuestionSetsRepository } from './featured-question-sets.repo.js';

/**
 * 精选题集仓储单测（mock 版）。
 *
 * mock 值按真实 MySQL 语义塑造，而非照抄 brief 的示例：
 * - `INSERT .. ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`：fresh INSERT 的
 *   `affectedRows=1`；duplicate 分支 `affectedRows=2`（或 NO-OP 时 0，见实现注释）。
 *   两种情况下 `insertId` 都等于题集 id —— 所以「insertId === selected id」不能用来判新集。
 * - `INSERT IGNORE`：`affectedRows=1` 表示新行，`0` 表示命中唯一键被忽略。
 * - 带 `LIMIT ?` 的分页查询必须走 `pool.query`（服务端预处理语句不接受 LIMIT 占位符）。
 */

const sqlOf = (call: unknown[]): string => String(call[0]);
const paramsOf = (call: unknown[]): unknown[] => (call[1] ?? []) as unknown[];

function makeConn() {
  return {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    execute: vi.fn(),
  };
}

/** 用给定连接构造仓储（只暴露 getConnection，符合 Pool 注入契约）。 */
function repoWithConn(conn: ReturnType<typeof makeConn>) {
  const getConnection = vi.fn().mockResolvedValue(conn);
  return {
    repo: new FeaturedQuestionSetsRepository({ getConnection } as never),
    getConnection,
  };
}

/** 用仅带 execute/query 的 mock pool 构造仓储。 */
function repoWithPool(execute = vi.fn(), query = vi.fn()) {
  const pool = { execute, query };
  return {
    repo: new FeaturedQuestionSetsRepository(pool as never),
    execute,
    query,
  };
}

const itemInsert = /INSERT\s+(?:IGNORE\s+)?INTO\s+featured_question_set_items/;

describe('FeaturedQuestionSetsRepository — 推荐事务', () => {
  it('相同 content_key 命中既有题集时不重复建 items（affectedRows=2 = duplicate）', async () => {
    const conn = makeConn();
    conn.execute
      .mockResolvedValueOnce([{ insertId: 42, affectedRows: 2 }, []]) // set upsert：duplicate UPDATE
      .mockResolvedValueOnce([[{ id: 42 }], []])                      // SELECT id
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);              // 推荐 INSERT IGNORE：新行
    const { repo, getConnection } = repoWithConn(conn);

    const out = await repo.createRecommendation({
      subjectId: 1,
      questionIds: [3, 7],
      contentKey: 'k',
      studentId: 9,
      gradeCode: 'grade_7',
      dailyLimitReached: false,
    });

    expect(out).toEqual({ setId: 42, alreadyRecommended: false });
    expect(getConnection).toHaveBeenCalledTimes(1);
    expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(conn.execute).toHaveBeenCalledTimes(3);
    expect(conn.execute.mock.calls.filter((c) => itemInsert.test(sqlOf(c)))).toHaveLength(0);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);

    expect(sqlOf(conn.execute.mock.calls[0])).toContain('ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)');
    expect(paramsOf(conn.execute.mock.calls[0])).toEqual(['k', 1, 9, 2]);
    expect(sqlOf(conn.execute.mock.calls[1])).toContain('SELECT id FROM featured_question_sets WHERE content_key = ?');
    expect(paramsOf(conn.execute.mock.calls[1])).toEqual(['k']);
    expect(sqlOf(conn.execute.mock.calls[2])).toContain('INSERT IGNORE INTO featured_question_set_recommendations');
    expect(paramsOf(conn.execute.mock.calls[2])).toEqual([42, 9, 'grade_7']);
  });

  it('新建题集（affectedRows=1）才写 items，按输入顺序写 sort_order', async () => {
    const conn = makeConn();
    conn.execute
      .mockResolvedValueOnce([{ insertId: 7, affectedRows: 1 }, []]) // set upsert：fresh INSERT
      .mockResolvedValueOnce([[{ id: 7 }], []])                      // SELECT id
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])              // item 3
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])              // item 7
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);             // 推荐：新行
    const { repo } = repoWithConn(conn);

    const out = await repo.createRecommendation({
      subjectId: 1,
      questionIds: [3, 7],
      contentKey: 'fresh',
      studentId: 9,
      gradeCode: 'grade_7',
      dailyLimitReached: false,
    });

    expect(out).toEqual({ setId: 7, alreadyRecommended: false });
    const itemCalls = conn.execute.mock.calls.filter((c) => itemInsert.test(sqlOf(c)));
    expect(itemCalls).toHaveLength(2);
    expect(itemCalls.map(paramsOf)).toEqual([
      [7, 3, 0],
      [7, 7, 1],
    ]);
    expect(conn.commit).toHaveBeenCalledTimes(1);
  });

  it('duplicate recommendation（INSERT IGNORE affectedRows=0）返回 alreadyRecommended=true', async () => {
    const conn = makeConn();
    conn.execute
      .mockResolvedValueOnce([{ insertId: 42, affectedRows: 2 }, []]) // 已有题集
      .mockResolvedValueOnce([[{ id: 42 }], []])                      // SELECT id
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);              // 推荐命中唯一键，被忽略
    const { repo } = repoWithConn(conn);

    const out = await repo.createRecommendation({
      subjectId: 1,
      questionIds: [3],
      contentKey: 'k',
      studentId: 9,
      gradeCode: 'grade_7',
      dailyLimitReached: false,
    });

    expect(out).toEqual({ setId: 42, alreadyRecommended: true });
    expect(conn.execute.mock.calls.filter((c) => itemInsert.test(sqlOf(c)))).toHaveLength(0);
    expect(conn.commit).toHaveBeenCalledTimes(1);
  });

  it('任一步失败都 rollback 并释放连接，不 commit', async () => {
    const conn = makeConn();
    conn.execute
      .mockResolvedValueOnce([{ insertId: 7, affectedRows: 1 }, []]) // set upsert OK
      .mockResolvedValueOnce([[{ id: 7 }], []])                      // SELECT id OK
      .mockRejectedValueOnce(new Error('item insert failed'));        // item 写入失败
    const { repo } = repoWithConn(conn);

    await expect(
      repo.createRecommendation({
        subjectId: 1,
        questionIds: [3],
        contentKey: 'boom',
        studentId: 9,
        gradeCode: 'grade_7',
        dailyLimitReached: false,
      }),
    ).rejects.toThrow('item insert failed');

    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('额度已满 + 新建题集（affectedRows=1）→ 429/1008，rollback 且不写 items/推荐票', async () => {
    const conn = makeConn();
    conn.execute
      .mockResolvedValueOnce([{ insertId: 7, affectedRows: 1 }, []]); // set upsert：fresh INSERT
    const { repo } = repoWithConn(conn);

    const err = await repo.createRecommendation({
      subjectId: 1,
      questionIds: [3, 7],
      contentKey: 'fresh-at-cap',
      studentId: 9,
      gradeCode: 'grade_7',
      dailyLimitReached: true,
    }).catch((e) => e);

    expect(err.getStatus()).toBe(429);
    expect(err.response).toMatchObject({ code: 1008, message: '今日推荐已达上限，请明天再试' });
    expect(conn.execute).toHaveBeenCalledTimes(1); // 判定 fresh 后立即拒绝，不再写 items / 推荐票
    expect(conn.execute.mock.calls.filter((c) => itemInsert.test(sqlOf(c)))).toHaveLength(0);
    expect(conn.execute.mock.calls.some((c) => sqlOf(c).includes('featured_question_set_recommendations'))).toBe(false);
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('额度已满但命中既有题集（affectedRows=2）→ 幂等成功，不 429、不 rollback', async () => {
    const conn = makeConn();
    conn.execute
      .mockResolvedValueOnce([{ insertId: 42, affectedRows: 2 }, []]) // duplicate UPDATE
      .mockResolvedValueOnce([[{ id: 42 }], []])                      // SELECT id
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);              // 推荐命中唯一键 → alreadyRecommended=true
    const { repo } = repoWithConn(conn);

    await expect(repo.createRecommendation({
      subjectId: 1,
      questionIds: [3],
      contentKey: 'dup-at-cap',
      studentId: 9,
      gradeCode: 'grade_7',
      dailyLimitReached: true,
    })).resolves.toEqual({ setId: 42, alreadyRecommended: true });

    expect(conn.execute.mock.calls.filter((c) => itemInsert.test(sqlOf(c)))).toHaveLength(0);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
  });
});

describe('FeaturedQuestionSetsRepository — 限流、审核与状态迁移', () => {
  it('countSetsCreatedToday 按 created_at >= CURDATE() 统计该生今日新建题集', async () => {
    const { repo, execute } = repoWithPool();
    execute.mockResolvedValueOnce([[{ cnt: 4 }], []]);

    await expect(repo.countSetsCreatedToday(9)).resolves.toBe(4);
    expect(sqlOf(execute.mock.calls[0])).toContain('created_at >= CURDATE()');
    expect(paramsOf(execute.mock.calls[0])).toEqual([9]);
  });

  it('publish：有效同 set/grade 只更新标题，不覆盖发布快照', async () => {
    const conn = makeConn();
    conn.execute
      .mockResolvedValueOnce([[{ id: 5, review_status: 'pending' }], []])
      .mockResolvedValueOnce([[{ id: 22 }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const { repo } = repoWithConn(conn);

    await expect(
      repo.publish({
        setId: 5,
        title: '八年级数学精选',
        gradeCode: 'grade_8',
        reviewerId: 8,
        reachCount: 36,
      }),
    ).resolves.toEqual({ publicationId: 22 });

    expect(sqlOf(conn.execute.mock.calls[2])).toContain(
      'UPDATE featured_question_set_publications SET title = ? WHERE id = ? AND withdrawn_at IS NULL',
    );
    expect(paramsOf(conn.execute.mock.calls[2])).toEqual(['八年级数学精选', 22]);
    expect(conn.execute.mock.calls.some((c) =>
      sqlOf(c).includes('INSERT INTO featured_question_set_publications'))).toBe(false);
    expect(conn.execute.mock.calls.some((c) => sqlOf(c).includes("review_status = 'approved'"))).toBe(true);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
  });

  it('publish：无有效 publication 时插入新行', async () => {
    const conn = makeConn();
    conn.execute
      .mockResolvedValueOnce([[{ id: 5, review_status: 'approved' }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ insertId: 31, affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    const { repo } = repoWithConn(conn);

    await expect(
      repo.publish({ setId: 5, title: '重新发布', gradeCode: 'grade_8', reviewerId: 8, reachCount: 20 }),
    ).resolves.toEqual({ publicationId: 31 });

    const insertCall = conn.execute.mock.calls[2];
    expect(sqlOf(insertCall)).toContain('INSERT INTO featured_question_set_publications');
    expect(sqlOf(insertCall)).toContain('active_publication_key');
    expect(paramsOf(insertCall)).toEqual([5, 'grade_8', '重新发布', 20, 8, '5:grade_8']);
    expect(conn.execute.mock.calls.some((c) =>
      sqlOf(c).includes('DELETE FROM featured_question_set_reads'))).toBe(false);
  });

  it('publish：rejected 题集禁止发布并 rollback', async () => {
    const conn = makeConn();
    conn.execute.mockResolvedValueOnce([[{ id: 5, review_status: 'rejected' }], []]);
    const { repo } = repoWithConn(conn);

    await expect(
      repo.publish({ setId: 5, title: 'x', gradeCode: 'grade_8', reviewerId: 8, reachCount: 1 }),
    ).rejects.toThrow(/rejected/);

    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.execute.mock.calls.some((c) => sqlOf(c).includes('INSERT INTO featured_question_set_publications'))).toBe(false);
  });

  it('reject 只允许 pending，写 reviewer 与时间', async () => {
    const { repo, execute } = repoWithPool();
    execute.mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    await repo.reject(5, 8);

    expect(sqlOf(execute.mock.calls[0])).toContain("review_status = 'rejected'");
    expect(sqlOf(execute.mock.calls[0])).toContain("review_status = 'pending'");
    expect(paramsOf(execute.mock.calls[0])).toEqual([8, 5]);
  });

  it('reopen 只允许 rejected，置 pending 并清空 reviewer/时间', async () => {
    const { repo, execute } = repoWithPool();
    execute.mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    await repo.reopen(5);

    expect(sqlOf(execute.mock.calls[0])).toContain("review_status = 'pending'");
    expect(sqlOf(execute.mock.calls[0])).toContain('reviewed_by = NULL');
    expect(sqlOf(execute.mock.calls[0])).toContain("review_status = 'rejected'");
    expect(paramsOf(execute.mock.calls[0])).toEqual([5]);
  });

  it('withdraw 只更新当前有效 publication，不删除任何历史', async () => {
    const conn = makeConn();
    conn.execute.mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const { repo } = repoWithConn(conn);

    await repo.withdraw(22, 8);

    expect(conn.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET active_publication_key = NULL, withdrawn_by = ?, withdrawn_at = NOW(3)'),
      [8, 22],
    );
    expect(sqlOf(conn.execute.mock.calls[0])).toContain('withdrawn_at IS NULL');
    expect(conn.execute.mock.calls.some((c) => /DELETE FROM special_practice_sessions/.test(sqlOf(c)))).toBe(false);
    expect(conn.commit).toHaveBeenCalledTimes(1);
  });

  it('pendingCount 统计 pending 题集', async () => {
    const { repo, execute } = repoWithPool();
    execute.mockResolvedValueOnce([[{ cnt: 3 }], []]);

    await expect(repo.pendingCount()).resolves.toBe(3);
    expect(sqlOf(execute.mock.calls[0])).toContain("review_status = 'pending'");
  });
});

describe('FeaturedQuestionSetsRepository — 学生投递', () => {
  const pubRow = {
    publication_id: 12,
    set_id: 7,
    title: '七年级数学精选',
    subject_id: 1,
    subject_name: '数学',
    published_at: new Date('2026-11-28T00:00:00Z'),
    is_read: 0,
    available_count: 5,
  };

  it('listStudentPublications 只查目标年级、published 且至少一题在架（分页走 pool.query）', async () => {
    const { repo, execute, query } = repoWithPool();
    execute.mockResolvedValueOnce([[{ cnt: 1 }], []]); // 总数
    query.mockResolvedValueOnce([[pubRow], []]);        // 分页列表

    const out = await repo.listStudentPublications(9, 'grade_7', 1, 20);

    expect(out).toEqual({
      items: [
        {
          publicationId: 12,
          setId: 7,
          title: '七年级数学精选',
          subjectId: 1,
          subjectName: '数学',
          questionCount: 5,
          publishedAt: pubRow.published_at,
          isRead: false,
        },
      ],
      total: 1,
    });

    const listCall = query.mock.calls.find((c) => sqlOf(c).includes('featured_question_set_publications'))!;
    expect(listCall).toBeDefined();
    expect(sqlOf(listCall)).toContain('withdrawn_at IS NULL');
    expect(sqlOf(listCall)).toContain('grade_code = ?');
    expect(sqlOf(listCall)).toContain('available_count > 0');
    expect(paramsOf(listCall)).toEqual(['grade_7', 9, 20, 0]);
    expect(execute).toHaveBeenCalledTimes(1); // LIMIT ? 绝不走 execute
  });

  it('listStudentPublications 越界页返回空 items', async () => {
    const { repo, execute, query } = repoWithPool();
    execute.mockResolvedValueOnce([[{ cnt: 1 }], []]);
    query.mockResolvedValueOnce([[], []]);

    const out = await repo.listStudentPublications(9, 'grade_7', 99, 20);

    expect(out.items).toEqual([]);
    expect(out.total).toBe(1);
    expect(paramsOf(query.mock.calls[0])).toEqual(['grade_7', 9, 20, 1960]);
  });

  it('unreadSummary 返回 count 与最新未读 publication', async () => {
    const { repo, execute } = repoWithPool();
    execute
      .mockResolvedValueOnce([[{ c: 2 }], []])
      .mockResolvedValueOnce([[{ publicationId: 8, title: '最新精选' }], []]);

    await expect(repo.unreadSummary(9, 'grade_7')).resolves.toEqual({
      count: 2,
      latest: { publicationId: 8, title: '最新精选' },
    });

    expect(sqlOf(execute.mock.calls[0])).toContain('withdrawn_at IS NULL');
    expect(sqlOf(execute.mock.calls[0])).toContain('available_count > 0');
    expect(paramsOf(execute.mock.calls[0])).toEqual(['grade_7', 9]);
    expect(sqlOf(execute.mock.calls[1])).toContain('withdrawn_at IS NULL');
    expect(paramsOf(execute.mock.calls[1])).toEqual(['grade_7', 9]);
    expect(sqlOf(execute.mock.calls[1])).toContain('LIMIT 1');
  });

  it('unreadSummary 无未读时 latest 为 null', async () => {
    const { repo, execute } = repoWithPool();
    execute
      .mockResolvedValueOnce([[{ c: 0 }], []])
      .mockResolvedValueOnce([[], []]);

    await expect(repo.unreadSummary(9, 'grade_7')).resolves.toEqual({ count: 0, latest: null });
  });

  it('findOpenPublication 只返回 published 且年级匹配，题目按 sort_order, q.sub_no 排序', async () => {
    const conn = makeConn();
    conn.execute
      .mockResolvedValueOnce([[{ publication_id: 22, set_id: 7, title: '七年级数学精选', subject_id: 1 }], []])
      .mockResolvedValueOnce([[
        {
          id: 3, subject_id: 1, content: '题一', type: 'choice', options: null,
          answer: 'A', explanation: null, material_text: null, material_url: null,
          sub_no: 0, source: null, question_no: 4,
        },
      ], []]);
    const { repo } = repoWithConn(conn);

    const out = await repo.findOpenPublication(22, 'grade_7', conn as never);

    expect(out).toEqual({
      publicationId: 22,
      setId: 7,
      title: '七年级数学精选',
      subjectId: 1,
      questions: [
        {
          id: 3, subject_id: 1, content: '题一', type: 'choice', options: null,
          answer: 'A', explanation: null, material_text: null, material_url: null,
          sub_no: 0, source: null, question_no: 4,
        },
      ],
    });
    expect(sqlOf(conn.execute.mock.calls[0])).toContain('p.withdrawn_at IS NULL');
    expect(sqlOf(conn.execute.mock.calls[0])).toContain('p.grade_code = ?');
    // 设计 §6.1 步骤 1：open 事务内先锁 publication，避免并发撤回/重发读到旧题单。
    expect(sqlOf(conn.execute.mock.calls[0])).toContain('FOR UPDATE');
    expect(paramsOf(conn.execute.mock.calls[0])).toEqual([22, 'grade_7']);
    expect(sqlOf(conn.execute.mock.calls[1])).toContain('ORDER BY fqsi.sort_order, q.sub_no');
    expect(sqlOf(conn.execute.mock.calls[1])).toContain('q.is_active = 1');
    expect(paramsOf(conn.execute.mock.calls[1])).toEqual([7]);
  });

  it('findOpenPublication 找不到/越年级/已撤回时返回 null', async () => {
    const { repo, execute } = repoWithPool();
    execute.mockResolvedValueOnce([[], []]);

    await expect(repo.findOpenPublication(22, 'grade_7')).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('findOpenPublication 全部题下架时返回 null（不投递、不写已读）', async () => {
    const { repo, execute } = repoWithPool();
    execute
      .mockResolvedValueOnce([[{ publication_id: 22, set_id: 7, title: '旧题单', subject_id: 1 }], []])
      .mockResolvedValueOnce([[], []]); // 无任何在架题

    await expect(repo.findOpenPublication(22, 'grade_7')).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('markRead 用 INSERT IGNORE 幂等写入，支持传入事务连接', async () => {
    const conn = makeConn();
    conn.execute.mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const { repo } = repoWithConn(conn);

    await repo.markRead(22, 9, conn as never);

    expect(sqlOf(conn.execute.mock.calls[0])).toContain('INSERT IGNORE INTO featured_question_set_reads');
    expect(paramsOf(conn.execute.mock.calls[0])).toEqual([22, 9]);
  });
});

describe('FeaturedQuestionSetsRepository — 教研审核列表', () => {
  it('listReviewSets 只返回聚合人数与年级分布，不含 student_id/姓名（分页走 pool.query）', async () => {
    const { repo, execute, query } = repoWithPool();
    execute
      .mockResolvedValueOnce([[{ cnt: 1 }], []]); // 总数
    query.mockResolvedValueOnce([[
      {
        set_id: 7, subject_id: 1, subject_name: '数学', question_count: 5,
        review_status: 'pending', created_at: new Date('2026-11-28T00:00:00Z'),
        recommendation_count: 3,
      },
    ], []]); // 分页列表
    execute.mockResolvedValueOnce([[
      { set_id: 7, grade_code: 'grade_7', cnt: 2 },
      { set_id: 7, grade_code: 'grade_8', cnt: 1 },
    ], []]); // 年级分布

    const out = await repo.listReviewSets('pending', 1, 20);

    expect(out.total).toBe(1);
    expect(out.items).toEqual([
      {
        setId: 7,
        subjectId: 1,
        subjectName: '数学',
        questionCount: 5,
        recommendationCount: 3,
        gradeDistribution: [
          { gradeCode: 'grade_7', count: 2 },
          { gradeCode: 'grade_8', count: 1 },
        ],
        reviewStatus: 'pending',
        createdAt: new Date('2026-11-28T00:00:00Z'),
      },
    ]);
    const allSql = [...execute.mock.calls, ...query.mock.calls].map((c) => sqlOf(c)).join('\n');
    expect(allSql).not.toMatch(/student_id|student_name|username|s\.name/);
    expect(paramsOf(query.mock.calls[0])).toEqual(['pending', 20, 0]);
  });

  it('listReviewSets 默认 pageSize=20，越界返回空 items', async () => {
    const { repo, execute, query } = repoWithPool();
    execute.mockResolvedValueOnce([[{ cnt: 1 }], []]);
    query.mockResolvedValueOnce([[], []]);

    const out = await repo.listReviewSets('pending', 99, 20);

    expect(out.items).toEqual([]);
    expect(out.total).toBe(1);
    expect(query).toHaveBeenCalledTimes(1); // 无题集不发分布查询
  });

  it('getReviewSet 返回题目与 publication 明细，不存在返回 null', async () => {
    const { repo, execute } = repoWithPool();
    execute
      .mockResolvedValueOnce([[
        {
          set_id: 7, subject_id: 1, subject_name: '数学', question_count: 5,
          review_status: 'pending', created_at: new Date('2026-11-28T00:00:00Z'),
          recommendation_count: 3,
        },
      ], []])
      .mockResolvedValueOnce([[{ grade_code: 'grade_7', cnt: 3 }], []]) // 年级分布
      .mockResolvedValueOnce([[
        { question_id: 3, text: '题一', type: 'choice', answer: 'A', explanation: null },
      ], []])
      .mockResolvedValueOnce([[
        {
          publication_id: 22, grade_code: 'grade_7', title: '七年级数学精选',
          reach_count: 36, status: 'published', published_at: new Date('2026-11-28T00:00:00Z'),
        },
        {
          publication_id: 21, grade_code: 'grade_7', title: '七年级旧投递',
          reach_count: 18, status: 'withdrawn', published_at: new Date('2026-11-20T00:00:00Z'),
        },
      ], []]);

    const detail = await repo.getReviewSet(7);

    expect(detail).toMatchObject({
      setId: 7,
      subjectName: '数学',
      recommendationCount: 3,
      gradeDistribution: [{ gradeCode: 'grade_7', count: 3 }],
      questions: [{ questionId: 3, text: '题一', answer: 'A' }],
      publications: [
        { publicationId: 22, gradeCode: 'grade_7', reachCount: 36, status: 'published' },
        { publicationId: 21, gradeCode: 'grade_7', reachCount: 18, status: 'withdrawn' },
      ],
    });
    const publicationSql = sqlOf(execute.mock.calls[3]);
    expect(publicationSql).toContain("WHEN p.withdrawn_at IS NULL THEN 'published'");
    expect(publicationSql).toContain("ELSE 'withdrawn'");

    const missing = repoWithPool();
    missing.execute.mockResolvedValueOnce([[], []]);
    await expect(missing.repo.getReviewSet(999)).resolves.toBeNull();
  });
});
