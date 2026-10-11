import { describe, it, expect, vi } from 'vitest';
import { VariationQuestionsRepository } from './variation-questions.repo';

/** mockPool：execute 走 prepared statement —— SELECT 返回 [rows, []]，
 *  INSERT/UPDATE/DELETE 返回 [ResultSetHeader, []]。 */
const mockPool = (rows: any[] = [], affected = 0, insertId = 0) => ({
  execute: vi.fn().mockImplementation((sql: string) => {
    return Promise.resolve(
      sql.trim().toUpperCase().startsWith('SELECT')
        ? [rows, []]
        : [{ affectedRows: affected, insertId }, []],
    ) as any;
  }),
});

describe('VariationQuestionsRepository.hasPendingByErrorItem', () => {
  it('有 pending 行返回 true，SQL 按 (original_error_item_id, is_correct IS NULL) 过滤', async () => {
    const pool = mockPool([{ '1': 1 }]);
    const repo = new VariationQuestionsRepository(pool as any);
    expect(await repo.hasPendingByErrorItem(33)).toBe(true);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('original_error_item_id = ?');
    expect(sql).toContain('is_correct IS NULL');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual([33]);
  });

  it('无 pending 行返回 false', async () => {
    const repo = new VariationQuestionsRepository(mockPool([]) as any);
    expect(await repo.hasPendingByErrorItem(33)).toBe(false);
  });
});

describe('VariationQuestionsRepository.findPendingByStudent', () => {
  it('不带 errorBookId：单参数查询，ORDER BY id DESC', async () => {
    const row = { id: 5, original_error_item_id: 33, question_id: 88, difficulty: 2 };
    const pool = mockPool([row]);
    const repo = new VariationQuestionsRepository(pool as any);
    expect(await repo.findPendingByStudent(7)).toEqual([row]);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('student_id = ?');
    expect(sql).toContain('is_correct IS NULL');
    expect(sql).not.toContain('original_error_item_id = ?');
    expect(sql).toContain('ORDER BY id DESC');
    expect(params).toEqual([7]);
  });

  it('带 errorBookId：追加 original_error_item_id 过滤（他人条目天然查不到，不泄漏）', async () => {
    const pool = mockPool([]);
    const repo = new VariationQuestionsRepository(pool as any);
    await repo.findPendingByStudent(7, 33);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('AND original_error_item_id = ?');
    expect(params).toEqual([7, 33]);
  });
});

describe('VariationQuestionsRepository.findPendingByQuestion', () => {
  it('命中返回首行；SQL 限定 student + question + pending，LIMIT 1', async () => {
    const row = { id: 5, student_id: 7, question_id: 88, is_correct: null };
    const pool = mockPool([row]);
    const repo = new VariationQuestionsRepository(pool as any);
    expect(await repo.findPendingByQuestion(7, 88)).toEqual(row);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('student_id = ?');
    expect(sql).toContain('question_id = ?');
    expect(sql).toContain('is_correct IS NULL');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual([7, 88]);
  });

  it('未命中（已作答/不存在）返回 null', async () => {
    const repo = new VariationQuestionsRepository(mockPool([]) as any);
    expect(await repo.findPendingByQuestion(7, 88)).toBeNull();
  });
});

describe('VariationQuestionsRepository.insert', () => {
  it('写入六列，不写 is_correct/answered_at（走 DB 默认 NULL=待练）', async () => {
    const pool = mockPool([], 1, 42);
    const repo = new VariationQuestionsRepository(pool as any);
    const id = await repo.insert({
      original_error_item_id: 33,
      error_book_type: 'main',
      student_id: 7,
      question_id: 88,
      difficulty: 2,
      validator_passed: 1,
    });
    expect(id).toBe(42);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO variation_questions');
    expect(sql).not.toContain('is_correct');
    expect(sql).not.toContain('answered_at');
    expect(params).toEqual([33, 'main', 7, 88, 2, 1]);
  });
});

describe('VariationQuestionsRepository.markAnswered', () => {
  it('CAS：UPDATE 带 is_correct IS NULL 守卫，affectedRows 透传', async () => {
    const pool = mockPool([], 1);
    const repo = new VariationQuestionsRepository(pool as any);
    expect(await repo.markAnswered(5, true)).toBe(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('SET is_correct = ?, answered_at = NOW(3)');
    expect(sql).toContain('AND is_correct IS NULL');
    expect(params).toEqual([1, 5]);
  });

  it('并发已答：affectedRows = 0（调用方按「不在待练清单」处理）', async () => {
    const pool = mockPool([], 0);
    const repo = new VariationQuestionsRepository(pool as any);
    expect(await repo.markAnswered(5, false)).toBe(0);
    const [, params] = pool.execute.mock.calls[0];
    expect(params).toEqual([0, 5]);
  });
});
