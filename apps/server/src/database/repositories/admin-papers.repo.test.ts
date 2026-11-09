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
        if (/FROM paper_questions WHERE paper_id = \?$/i.test(sql)) return Promise.resolve([[{ cnt: 14 }], []]);
        if (/EXISTS \(SELECT 1 FROM paper_questions x/.test(sql)) return Promise.resolve([[{ cnt: 2 }], []]);
        if (/FROM exam_sessions WHERE paper_id = \?/i.test(sql)) return Promise.resolve([[{ cnt: 1 }], []]);
        if (/FROM exam_answers ea[\s\S]*JOIN exam_sessions es/.test(sql)) return Promise.resolve([[{ cnt: 5 }], []]);
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
  });
});
