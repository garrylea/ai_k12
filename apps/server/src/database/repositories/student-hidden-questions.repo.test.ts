import { describe, it, expect, vi } from 'vitest';
import { StudentHiddenQuestionsRepository } from './student-hidden-questions.repo';

/** mockPool：execute 走 prepared statement（INSERT/DELETE 返回 [ResultSetHeader, []]），
 *  query 走客户端转义（SELECT 返回 [rows, []]）。findAllByStudent 用 execute。 */
const mockPool = (rows: any[] = [], affected = 0) => ({
  execute: vi.fn().mockImplementation((sql: string) => {
    // SELECT 走 execute 时返回 [rows, []]；INSERT/DELETE 返回 [ResultSetHeader, []]
    return Promise.resolve(
      sql.trim().toUpperCase().startsWith('SELECT')
        ? [rows, []]
        : [{ affectedRows: affected }, []],
    ) as any;
  }),
  query: vi.fn().mockResolvedValue([rows, []] as any),
});

describe('StudentHiddenQuestionsRepository.mark', () => {
  it('INSERT IGNORE 幂等，参数 (studentId, subjectId, questionId)', async () => {
    const pool = mockPool([], 1);
    const repo = new StudentHiddenQuestionsRepository(pool as any);
    await repo.mark(7, 1, 10);
    expect(pool.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT IGNORE INTO student_hidden_questions');
    expect(sql).toContain('(student_id, subject_id, question_id)');
    expect(params).toEqual([7, 1, 10]);
  });
});

describe('StudentHiddenQuestionsRepository.unmark', () => {
  it('DELETE WHERE student_id=? AND question_id=?（归属校验防 IDOR）', async () => {
    const pool = mockPool([], 1);
    const repo = new StudentHiddenQuestionsRepository(pool as any);
    const n = await repo.unmark(7, 10);
    expect(n).toBe(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('DELETE FROM student_hidden_questions');
    expect(sql).toContain('student_id = ?');
    expect(sql).toContain('question_id = ?');
    expect(params).toEqual([7, 10]);
  });
});

describe('StudentHiddenQuestionsRepository.unmarkAll', () => {
  it('DELETE WHERE student_id=?', async () => {
    const pool = mockPool([], 3);
    const repo = new StudentHiddenQuestionsRepository(pool as any);
    const n = await repo.unmarkAll(7);
    expect(n).toBe(3);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('DELETE FROM student_hidden_questions');
    expect(sql).toContain('student_id = ?');
    expect(params).toEqual([7]);
  });
});

describe('StudentHiddenQuestionsRepository.findAllByStudent', () => {
  it('JOIN questions + 相关子查询取首个 primary kp 名，参数 (studentId, subjectId)', async () => {
    const rows = [{
      questionId: 10,
      questionText: '题面预览',
      type: 'choice',
      kpName: '有理数',
      markedAt: new Date('2026-09-04T00:00:00.000Z'),
    }];
    const pool = mockPool(rows);
    const repo = new StudentHiddenQuestionsRepository(pool as any);
    const r = await repo.findAllByStudent(7, 1);
    expect(r).toEqual(rows);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM student_hidden_questions shq');
    expect(sql).toContain('JOIN questions q ON q.id = shq.question_id');
    expect(sql).toContain('shq.student_id = ?');
    expect(sql).toContain('shq.subject_id = ?');
    expect(sql).toContain('ORDER BY shq.created_at DESC');
    expect(params).toEqual([7, 1]);
  });
});
