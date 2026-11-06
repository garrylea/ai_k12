import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpecialAnswerRecordsRepository } from './special-answer-records.repo.js';

function mockPool() {
  const execute = vi.fn();
  return { execute, query: execute } as any;
}

describe('SpecialAnswerRecordsRepository', () => {
  afterEach(() => vi.clearAllMocks());

  it('upsertAnswer question_id 非空走 ON DUPLICATE KEY UPDATE', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 } as any]);
    const repo = new SpecialAnswerRecordsRepository(pool as any);
    await repo.upsertAnswer({
      sessionId: 1, questionId: 100, questionOrder: 1, answerText: 'B',
      isCorrect: false, score: 0, method: 'exact', analysis: null,
    });
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('ON DUPLICATE KEY UPDATE'),
      expect.arrayContaining([1, 100, 1, 'B']),
    );
  });

  it('upsertSpecialAnswer question_id 为空先 DELETE 后 INSERT', async () => {
    const pool = mockPool();
    const repo = new SpecialAnswerRecordsRepository(pool as any);
    await repo.upsertSpecialAnswer({
      sessionId: 1, questionOrder: 1, refType: 'passage', refId: 42,
      sentenceIndex: 0, answerText: '{"author":"李白"}', isCorrect: true,
      method: 'exact', analysis: null,
    });
    // 先 DELETE
    expect(pool.execute).toHaveBeenNthCalledWith(1,
      expect.stringContaining('DELETE FROM special_answer_records'),
      expect.arrayContaining([1, 'passage', 42, 0]),
    );
    // 再 INSERT
    expect(pool.execute).toHaveBeenNthCalledWith(2,
      expect.stringContaining('INSERT INTO special_answer_records'),
      expect.any(Array),
    );
  });

  // 未作答占位行（2026-11-06）：数理化专项开练时把整轮题单落库，历史详情才能显示「未作答」。
  it('ensurePlannedQuestions 按显式 order 写入空作答行（中间有跳过项时保留原始位次）', async () => {
    const pool = { query: vi.fn().mockResolvedValue([{}]) };
    const repo = new SpecialAnswerRecordsRepository(pool as never);
    // 题单第 2 题失效被跳过：后一题必须仍是 order 3，而不是被压缩成 2。
    await repo.ensurePlannedQuestions(9, [
      { questionId: 11, order: 1 },
      { questionId: 13, order: 3 },
    ]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT IGNORE INTO special_answer_records');
    expect(params).toEqual([9, 11, 1, 9, 13, 3]);
  });

  it('ensurePlannedQuestions 空数组不查库（缺省入参不该产生任何 SQL）', async () => {
    const pool = { query: vi.fn() };
    const repo = new SpecialAnswerRecordsRepository(pool as never);
    await repo.ensurePlannedQuestions(9, []);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('listBySession 用 q.content 列名（questions 表无 text 列，防 ER_BAD_FIELD_ERROR 回归）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[], []]);
    const repo = new SpecialAnswerRecordsRepository(pool as any);
    await repo.listBySession(7);
    expect(pool.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('q.content AS question_content');
    expect(sql).not.toContain('q.text AS question_content');
    // 详情判断 canRedo / canSimilar 需要题目的在架标记
    expect(sql).toContain('q.is_active AS question_is_active');
    expect(sql).toContain('LEFT JOIN questions q');
    expect(sql).toContain('sar.session_id = ?');
    expect(params).toEqual([7]);
  });
});
