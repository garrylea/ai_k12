import { describe, expect, it, vi } from 'vitest';
import { QuestionsRepository } from './questions.repo';

describe('QuestionsRepository.findByContentPrefix', () => {
  it('传 subjectId 时 SQL 带 subject_id 条件', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[], []]), query: vi.fn() };
    const repo = new QuestionsRepository(pool as any);
    await repo.findByContentPrefix('阅读下面的文字，完成题目', { subjectId: 2 });

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('subject_id = ?');
    expect(params).toEqual(['阅读下面的文', 2]);
  });
});
