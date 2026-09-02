import { describe, it, expect, vi } from 'vitest';
import { QuestionsRepository } from './questions.repo';

/** mockPool：SELECT 一律返回 rows（main-error-books.repo.test.ts 同款形状）。 */
const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
});

describe('QuestionsRepository.findRandomByKpAndType', () => {
  it('SQL 含 JOIN qkp / 空答案过滤 / RAND() / LIMIT ?，type 非空时带题型过滤', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findRandomByKpAndType(1, 3, 'proof', 5);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('JOIN question_knowledge_points qkp');
    expect(sql).toContain('qkp.knowledge_point_id = ?');
    expect(sql).toContain('q.subject_id = ?');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain('q.type = ?');
    // 终审备忘：choice/true_false 空答案题不出现在专项练习
    expect(sql).toContain("NOT (q.type IN ('choice','true_false') AND q.answer = '')");
    expect(sql).toContain('RAND()');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual([1, 3, 'proof', 5]);
  });

  it('type=null 时 SQL 不含题型过滤，参数省略 type', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findRandomByKpAndType(1, 3, null, 10);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).not.toContain('q.type = ?');
    expect(params).toEqual([1, 3, 10]);
  });

  it('返回 QuestionRow 行', async () => {
    const row = { id: 10, type: 'choice', content: '题面', answer: 'A' };
    const repo = new QuestionsRepository(mockPool([row]) as any);
    const rows = await repo.findRandomByKpAndType(1, 3, null, 5);
    expect(rows).toEqual([row]);
  });
});
