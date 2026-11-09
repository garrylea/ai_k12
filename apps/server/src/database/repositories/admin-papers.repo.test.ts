import { describe, expect, it, vi } from 'vitest';
import { AdminPapersRepository } from './admin-papers.repo.js';

/** mysql2 双返回形状：[rows, fields]；SELECT 可能走 execute 或 query。 */
function mockPool(rows: any[] = [], total = 0) {
  return {
    execute: vi.fn().mockImplementation((sql: string) => {
      if (/COUNT\(\*\) AS total/i.test(sql)) return Promise.resolve([[{ total }], []]);
      return Promise.resolve([rows, []]);
    }),
    query: vi.fn().mockResolvedValue([rows, []]),
  };
}

describe('AdminPapersRepository.findPapers', () => {
  it('分页查询走 pool.query（LIMIT ? 不能走 execute），总数走 execute', async () => {
    const pool = mockPool([{ id: 1 }], 3);
    const repo = new AdminPapersRepository(pool as any);

    const out = await repo.findPapers({ page: 2, pageSize: 20 });

    expect(out.total).toBe(3);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('LIMIT ? OFFSET ?');
    expect(sql).toContain('linked_question_count');
    expect(params).toEqual([20, 20]);
    expect(pool.execute.mock.calls[0][0]).toContain('COUNT(*) AS total');
  });

  it('subjectId / year / gradeBand / keyword 全部落到 WHERE 且参数顺序一致', async () => {
    const pool = mockPool([], 0);
    const repo = new AdminPapersRepository(pool as any);

    await repo.findPapers({ subjectId: 9, year: 2026, gradeBand: 'junior', keyword: '汇文', page: 1, pageSize: 10 });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('p.subject_id = ?');
    expect(sql).toContain('p.year = ?');
    expect(sql).toContain('p.grade_band = ?');
    expect(sql).toContain('p.title LIKE ?');
    // 4 个筛选 + LIMIT/OFFSET
    expect(params).toEqual([9, 2026, 'junior', '%汇文%', 10, 0]);
  });

  it('keyword 里的 % _ \\ 被转义，防通配符注入', async () => {
    const pool = mockPool([], 0);
    const repo = new AdminPapersRepository(pool as any);

    await repo.findPapers({ keyword: '50%_x\\y', page: 1, pageSize: 20 });

    expect(pool.query.mock.calls[0][1][0]).toBe('%50\\%\\_x\\\\y%');
  });
});

describe('AdminPapersRepository.countImpact', () => {
  it('独占 = 卷内题 - 共享；被引用题从可删里扣除', async () => {
    const pool = {
      execute: vi.fn().mockImplementation((sql: string, params: any[]) => {
        // 四个计数查询都以 COUNT(*) AS cnt 开头，用前缀区分，避免匹配到 UNION 里的子查询
        if (/SELECT COUNT\(\*\) AS cnt FROM paper_questions WHERE paper_id = \?$/i.test(sql)) return Promise.resolve([[{ cnt: 14 }], []]);
        // 共享题计数；带上 COUNT/别名前缀，避免与 findExclusiveIds 的 EXISTS 撞车
        if (/SELECT COUNT\(\*\) AS cnt FROM paper_questions pq[\s\S]*EXISTS\s*\(\s*SELECT 1 FROM paper_questions x/.test(sql)) {
          return Promise.resolve([[{ cnt: 2 }], []]);
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM exam_sessions WHERE paper_id = \?/i.test(sql)) return Promise.resolve([[{ cnt: 1 }], []]);
        if (/SELECT COUNT\(\*\) AS cnt FROM exam_answers ea[\s\S]*JOIN exam_sessions es/.test(sql)) return Promise.resolve([[{ cnt: 5 }], []]);
        if (/SELECT pq.question_id AS qid/.test(sql)) {
          return Promise.resolve([params.length ? Array.from({ length: 12 }, (_, i) => ({ qid: 100 + i })) : [], []]);
        }
        if (/SELECT DISTINCT qid FROM/.test(sql)) {
          // 12 道独占题里 3 道被错题本引用
          return Promise.resolve([[{ qid: 100 }, { qid: 101 }, { qid: 102 }], []]);
        }
        return Promise.resolve([[], []]);
      }),
    };
    const repo = new AdminPapersRepository(pool as any);

    const out = await repo.countImpact(446);

    expect(out.questionCount).toBe(14);
    expect(out.sharedCount).toBe(2);
    expect(out.exclusiveCount).toBe(12);
    expect(out.retainedCount).toBe(3);
    expect(out.deletableCount).toBe(9);
    expect(out.sessionCount).toBe(1);
    expect(out.answerCount).toBe(5);
  });

  it('被引用检测的 UNION 覆盖 7 张 RESTRICT 表', async () => {
    const pool = {
      execute: vi.fn().mockImplementation((sql: string) => {
        if (/SELECT pq.question_id AS qid/.test(sql)) {
          return Promise.resolve([[{ qid: 1 }, { qid: 2 }], []]);
        }
        if (/SELECT DISTINCT qid FROM/.test(sql)) return Promise.resolve([[], []]);
        return Promise.resolve([[{ cnt: 0 }], []]);
      }),
    };
    const repo = new AdminPapersRepository(pool as any);
    await repo.countImpact(1);

    const unionSql = pool.execute.mock.calls
      .map((c) => String(c[0]))
      .find((sql) => sql.includes('SELECT DISTINCT qid FROM'))!;
    for (const table of [
      'main_error_books', 'aux_error_books', 'answers', 'exam_answers',
      'variation_questions', 'special_answer_records', 'remediation_set_items',
    ]) {
      expect(unionSql).toContain(table);
    }
    // 本卷会话的作答不能算阻断（预览必须与执行一致）
    expect(unionSql).toContain('session_id NOT IN (SELECT id FROM exam_sessions WHERE paper_id = ?)');
  });

  it('exam_answers 分支排除本卷会话，且各分支参数与占位符按序对齐', async () => {
    const pool = {
      execute: vi.fn().mockImplementation((sql: string) => {
        if (/SELECT pq.question_id AS qid/.test(sql)) {
          return Promise.resolve([[{ qid: 1 }, { qid: 2 }], []]);
        }
        if (/SELECT DISTINCT qid FROM/.test(sql)) return Promise.resolve([[], []]);
        return Promise.resolve([[{ cnt: 0 }], []]);
      }),
    };
    const repo = new AdminPapersRepository(pool as any);
    await repo.countImpact(77);

    const call = pool.execute.mock.calls.find((c) => String(c[0]).includes('SELECT DISTINCT qid FROM'))!;
    const [sql, params] = call as [string, unknown[]];

    // 只有 exam_answers 分支带会话排除，且只出现一次
    expect(sql.match(/session_id NOT IN/g)).toHaveLength(1);
    expect(sql).toContain('session_id NOT IN (SELECT id FROM exam_sessions WHERE paper_id = ?)');
    // 7 分支 × 2 个 id 占位 + exam_answers 分支额外的 paper_id 占位
    expect(sql.split('?').length - 1).toBe(7 * 2 + 1);
    expect(params).toHaveLength(7 * 2 + 1);
    // 前 6 个分支各是 [1, 2]；最后是 exam_answers 分支的 [1, 2, paperId]
    expect(params.slice(0, 12)).toEqual([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
    expect(params.slice(-3)).toEqual([1, 2, 77]);
    expect(params.filter((p) => p === 77)).toHaveLength(1);
  });
});

function mockConn(overrides: { failOn?: string } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const conn = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    execute: vi.fn().mockImplementation((sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (overrides.failOn && sql.includes(overrides.failOn)) {
        return Promise.reject(Object.assign(new Error('fk'), { code: 'ER_ROW_IS_REFERENCED_2' }));
      }
      if (/SELECT id, title FROM exam_papers/.test(sql)) return Promise.resolve([[{ id: 446, title: '汇文卷' }], []]);
      if (/COUNT\(\*\) AS cnt FROM exam_sessions/.test(sql)) return Promise.resolve([[{ cnt: 1 }], []]);
      if (/FROM exam_answers ea JOIN/.test(sql)) return Promise.resolve([[{ cnt: 5 }], []]);
      if (/SELECT pq.question_id AS qid/.test(sql)) return Promise.resolve([[{ qid: 11 }, { qid: 12 }, { qid: 13 }], []]);
      if (/SELECT DISTINCT qid FROM/.test(sql)) return Promise.resolve([[{ qid: 13 }], []]);
      return Promise.resolve([{ affectedRows: 1 }, []]);
    }),
  };
  const pool = { getConnection: vi.fn().mockResolvedValue(conn) };
  return { pool, conn, calls };
}

describe('AdminPapersRepository.deletePaperCascade', () => {
  it('按「会话 → 题 → 卷」顺序删除，只删未被引用的独占题，返回真实计数', async () => {
    const { pool, conn, calls } = mockConn();
    const repo = new AdminPapersRepository(pool as any);

    const out = await repo.deletePaperCascade(446);

    expect(out).toEqual({
      paperTitle: '汇文卷',
      deletedQuestions: 2,
      retainedQuestions: 1,
      deletedSessions: 1,
      deletedAnswers: 5,
    });
    const sqls = calls.map((c) => c.sql);
    const sessionIdx = sqls.findIndex((s) => s.startsWith('DELETE FROM exam_sessions'));
    const questionIdx = sqls.findIndex((s) => s.startsWith('DELETE FROM questions'));
    const paperIdx = sqls.findIndex((s) => s.startsWith('DELETE FROM exam_papers'));
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(questionIdx).toBeGreaterThan(sessionIdx);
    expect(paperIdx).toBeGreaterThan(questionIdx);
    // 只删 11 / 12（13 被引用保留）
    expect(calls[questionIdx].params).toEqual([11, 12]);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('卷不存在 → 返回 null 并回滚，不提交', async () => {
    const conn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      execute: vi.fn().mockResolvedValue([[], []]),
    };
    const repo = new AdminPapersRepository({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    expect(await repo.deletePaperCascade(999)).toBeNull();
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('外键冲突 → 回滚并原样抛出（由 service 转 409）', async () => {
    const { pool, conn } = mockConn({ failOn: 'DELETE FROM exam_papers' });
    const repo = new AdminPapersRepository(pool as any);

    await expect(repo.deletePaperCascade(446)).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('全部题都被引用 → 跳过 DELETE questions，deletedQuestions=0', async () => {
    const conn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      execute: vi.fn().mockImplementation((sql: string) => {
        if (/SELECT id, title FROM exam_papers/.test(sql)) return Promise.resolve([[{ id: 1, title: 'x' }], []]);
        if (/COUNT\(\*\) AS cnt/.test(sql)) return Promise.resolve([[{ cnt: 0 }], []]);
        if (/SELECT pq.question_id AS qid/.test(sql)) return Promise.resolve([[{ qid: 11 }], []]);
        if (/SELECT DISTINCT qid FROM/.test(sql)) return Promise.resolve([[{ qid: 11 }], []]);
        return Promise.resolve([{ affectedRows: 0 }, []]);
      }),
    };
    const repo = new AdminPapersRepository({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    const out = await repo.deletePaperCascade(1);

    expect(out?.deletedQuestions).toBe(0);
    expect(out?.retainedQuestions).toBe(1);
    expect(conn.execute.mock.calls.some((c) => String(c[0]).includes('DELETE FROM questions WHERE id IN'))).toBe(false);
  });
});
