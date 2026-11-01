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
});
