import { describe, it, expect, vi } from 'vitest';
import { QuestionsRepository } from './questions.repo';

/** mockPool：SELECT 一律返回 rows（main-error-books.repo.test.ts 同款形状）。
 *  findRandomByKpAndType 用 pool.query（LIMIT ? 不能走 prepared statement，
 *  联调实测 mysql2 execute 报 Incorrect arguments to mysqld_stmt_execute）。 */
const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([[], []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('QuestionsRepository.findRandomByKpAndType', () => {
  it('SQL 含 LEFT JOIN student_hidden_questions / JOIN qkp / 空答案过滤 / RAND() / LIMIT ?，type 非空时带题型过滤', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findRandomByKpAndType(7, 1, 3, 'proof', 5);
    expect(pool.execute).not.toHaveBeenCalled();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('JOIN question_knowledge_points qkp');
    expect(sql).toContain('LEFT JOIN student_hidden_questions shq');
    expect(sql).toContain('shq.question_id = q.id AND shq.student_id = ?');
    expect(sql).toContain('shq.id IS NULL');
    expect(sql).toContain('qkp.knowledge_point_id = ?');
    expect(sql).toContain('q.subject_id = ?');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain('q.type = ?');
    // 判题体系重构 2026-09-09：空答案题一律排除
    expect(sql).toContain("q.answer <> ''");
    expect(sql).toContain('RAND()');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual([7, 1, 3, 'proof', 5]);
  });

  it('findRandomByKpAndType：空答案题全题型排除（q.answer <> \'\'）', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findRandomByKpAndType(7, 1, 5, null, 10);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("q.answer <> ''");
    expect(sql).not.toContain('NOT (q.type IN');
  });

  it('type=null 时 SQL 不含题型过滤，参数省略 type', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findRandomByKpAndType(7, 1, 3, null, 10);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('q.type = ?');
    expect(params).toEqual([7, 1, 3, 10]);
  });

  it('返回 QuestionRow 行', async () => {
    const row = { id: 10, type: 'choice', content: '题面', answer: 'A' };
    const repo = new QuestionsRepository(mockPool([row]) as any);
    const rows = await repo.findRandomByKpAndType(7, 1, 3, null, 5);
    expect(rows).toEqual([row]);
  });
});

describe('QuestionsRepository.updateExplanation', () => {
  it('执行 UPDATE questions SET explanation = ? WHERE id = ? 回写解析缓存', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.updateExplanation(1, '标准题解');
    expect(pool.query).not.toHaveBeenCalled();
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toBe('UPDATE questions SET explanation = ? WHERE id = ?');
    expect(params).toEqual(['标准题解', 1]);
  });
});
