import { describe, it, expect, vi } from 'vitest';
import { PracticeResultsRepository } from './practice-results.repo';

const mockPool = (rows: any[] = [], insertId = 7) => ({
  execute: vi.fn().mockImplementation((sql: string) => {
    const trimmed = sql.trim();
    if (/^INSERT/i.test(trimmed)) {
      return Promise.resolve([{ insertId, affectedRows: 1 }, []]);
    }
    if (/^UPDATE/i.test(trimmed)) {
      return Promise.resolve([{ affectedRows: 1, changedRows: 1 }, []]);
    }
    if (/^DELETE/i.test(trimmed)) {
      return Promise.resolve([{ affectedRows: 1 }, []]);
    }
    return Promise.resolve([rows, []]);
  }),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('PracticeResultsRepository', () => {
  it('upsert 执行 INSERT ... ON DUPLICATE KEY UPDATE，is_correct=false -> 0', async () => {
    const pool = mockPool();
    const repo = new PracticeResultsRepository(pool as any);
    await repo.upsert({
      student_id: 1, subject_id: 2, card_id: 5, lesson_id: 9,
      question_id: 10, question_n: '0-1', question_text: '题面',
      student_answer: '答', is_correct: false, method: 'ai',
      analysis: '错因', error_type: 'calculation',
    });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO practice_results');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(params).toEqual([1, 2, 5, 9, 10, '0-1', '题面', '答', 0, 'ai', '错因', 'calculation']);
  });

  it('upsert is_correct=true -> 1，question_id=null', async () => {
    const pool = mockPool();
    const repo = new PracticeResultsRepository(pool as any);
    await repo.upsert({
      student_id: 1, subject_id: 2, card_id: 5, lesson_id: 9,
      question_id: null, question_n: '0-2', question_text: '题',
      student_answer: '答', is_correct: true, method: 'exact',
      analysis: null, error_type: null,
    });
    const [, params] = pool.execute.mock.calls[0];
    expect(params[4]).toBeNull(); // question_id
    expect(params[8]).toBe(1);    // is_correct
  });

  it('findByStudentCard SELECT 按 student_id+card_id', async () => {
    const rows = [{ id: 1, question_n: '0-1', is_correct: 1 }];
    const pool = mockPool(rows);
    const repo = new PracticeResultsRepository(pool as any);
    const out = await repo.findByStudentCard(1, 5);
    expect(out).toEqual(rows);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('student_id = ?');
    expect(sql).toContain('card_id = ?');
    expect(params).toEqual([1, 5]);
  });

  it('deleteByStudentCard DELETE 按 student_id+card_id', async () => {
    const pool = mockPool();
    const repo = new PracticeResultsRepository(pool as any);
    await repo.deleteByStudentCard(1, 5);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('DELETE FROM practice_results');
    expect(sql).toContain('card_id = ?');
    expect(params).toEqual([1, 5]);
  });

  it('deleteByStudentLesson DELETE 按 student_id+lesson_id', async () => {
    const pool = mockPool();
    const repo = new PracticeResultsRepository(pool as any);
    await repo.deleteByStudentLesson(1, 9);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('DELETE FROM practice_results');
    expect(sql).toContain('lesson_id = ?');
    expect(params).toEqual([1, 9]);
  });
});
