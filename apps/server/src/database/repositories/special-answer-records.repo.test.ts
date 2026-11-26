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

  it('upsertAnswer 传 executor 时用该连接而非 pool', async () => {
    const pool = { execute: vi.fn(), query: vi.fn() };
    const exec = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }]), query: vi.fn() };
    const repo = new SpecialAnswerRecordsRepository(pool as any);
    await repo.upsertAnswer({
      sessionId: 1, questionId: 100, questionOrder: 1, answerText: 'B',
    }, exec as any);
    expect(pool.execute).not.toHaveBeenCalled();
    expect(exec.execute).toHaveBeenCalled();
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

  it('findForUpdate 用 FOR UPDATE 且带 session_id+question_id', async () => {
    const exec = { execute: vi.fn().mockResolvedValue([[], []]) };
    const repo = new SpecialAnswerRecordsRepository({} as any);
    await repo.findForUpdate(1, 5034, exec as any);
    const [sql, params] = exec.execute.mock.calls[0];
    expect(sql).toContain('FOR UPDATE');
    expect(params).toEqual([1, 5034]);
  });
  it('insertDefaultIncorrect 写 is_correct=0/self_assess_state=default_incorrect', async () => {
    const exec = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }]) };
    const repo = new SpecialAnswerRecordsRepository({} as any);
    await repo.insertDefaultIncorrect({ sessionId: 1, questionId: 5034, questionOrder: 1, answerText: 'x', method: 'self_assess' }, exec as any);
    const [sql, params] = exec.execute.mock.calls[0];
    expect(sql).toContain('self_assess_state');
    // 固定常量写进 SQL 字面量（brief 逐字 SQL），不占绑定参数位
    expect(sql).toContain(", 0, ?, 'default_incorrect', NOW(3))");
    expect(params).toEqual([1, 5034, 1, 'x', 'self_assess']);
  });
  it('claimPlaceholderAsDefaultIncorrect 认领占位行时不改 question_order', async () => {
    const exec = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }]) };
    const repo = new SpecialAnswerRecordsRepository({} as any);
    await repo.claimPlaceholderAsDefaultIncorrect(1, 5034, '我的解答', exec as any);
    const [sql, params] = exec.execute.mock.calls[0];
    // 事务内按 session+question 定位、单连接执行；SET 里没有 question_order
    expect(sql).toContain('UPDATE special_answer_records');
    expect(sql).toContain("is_correct = 0, method = 'self_assess'");
    expect(sql).toContain("self_assess_state = 'default_incorrect'");
    expect(sql).toContain('judged_at = NOW(3)');
    expect(sql).not.toContain('question_order =');
    expect(sql).toContain('WHERE session_id = ? AND question_id = ?');
    expect(params).toEqual(['我的解答', 1, 5034]);
  });

  it('transitionState 更新 is_correct/state/judged_at', async () => {
    const exec = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }]) };
    const repo = new SpecialAnswerRecordsRepository({} as any);
    await repo.transitionState({ sessionId: 1, questionId: 5034, state: 'confirmed_correct', isCorrect: 1, judgedAt: new Date() }, exec as any);
    const [sql] = exec.execute.mock.calls[0];
    expect(sql).toContain('self_assess_state');
    expect(sql).toContain('is_correct');
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
    // 老批量导入题没有 paper_questions 关联，题号退回 questions.group_order
    expect(sql).toContain('COALESCE(');
    expect(sql).toContain('q.group_order');
    expect(sql).toContain('AS question_paper_no');
    expect(sql).toContain('sar.session_id = ?');
    expect(params).toEqual([7]);
  });
});
