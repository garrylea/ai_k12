import { describe, it, expect, vi } from 'vitest';
import { ExamSessionsRepository } from './exam-sessions.repo';

/**
 * countAnswersBySession：练习记录「对 x/y」的口径。
 *
 * `total` 必须排除 method='no_standard_answer'（无参考答案不判不计），`unscored` 单列；
 * 974 卷 32 道在架无答案题不能显示成「对 0/32」。
 */
const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('ExamSessionsRepository.countAnswersBySession', () => {
  it('SQL 用 COALESCE 兜历史 NULL，并分别统计计分题 / 正确 / 无参考答案', async () => {
    const pool = mockPool([{ total: 0, correct: 0, unscored: 32 }]);
    const repo = new ExamSessionsRepository(pool as any);

    const r = await repo.countAnswersBySession(9);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain("COALESCE(method,'') <> 'no_standard_answer'");
    expect(sql).toContain("SUM(method = 'no_standard_answer')");
    expect(sql).toContain('FROM exam_answers WHERE session_id = ?');
    expect(params).toEqual([9]);
    expect(r).toEqual({ total: 0, correct: 0, unscored: 32 });
  });

  it('SUM 返回字符串（DECIMAL）也归一化为 number', async () => {
    const pool = mockPool([{ total: '10', correct: '7', unscored: '2' }]);
    const repo = new ExamSessionsRepository(pool as any);

    await expect(repo.countAnswersBySession(1)).resolves.toEqual({
      total: 10, correct: 7, unscored: 2,
    });
  });
});
