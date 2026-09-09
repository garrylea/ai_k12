import { describe, it, expect, vi } from 'vitest';
import { QuestionSelfAssessmentsRepository } from './question-self-assessments.repo';

const mockPool = (rows: any[] = [], insertId = 1) => ({
  execute: vi.fn().mockImplementation((sql: string) =>
    Promise.resolve(
      sql.trim().toUpperCase().startsWith('SELECT')
        ? [rows, []]
        : [{ insertId, affectedRows: 1 }, []],
    ) as any),
  query: vi.fn().mockResolvedValue([rows, []] as any),
});

describe('QuestionSelfAssessmentsRepository.create', () => {
  it('INSERT 四列，参数 (studentId, questionId, assessment, source)', async () => {
    const pool = mockPool();
    const repo = new QuestionSelfAssessmentsRepository(pool as any);
    const id = await repo.create({ studentId: 7, questionId: 10, assessment: 'incorrect', source: 'targeted' });
    expect(id).toBe(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO question_self_assessments');
    expect(sql).toContain('(student_id, question_id, assessment, source)');
    expect(params).toEqual([7, 10, 'incorrect', 'targeted']);
  });
});

describe('QuestionSelfAssessmentsRepository.findLatestByStudentAndQuestionIds', () => {
  it('空列表直接返回空 Map，不发 SQL', async () => {
    const pool = mockPool();
    const repo = new QuestionSelfAssessmentsRepository(pool as any);
    const m = await repo.findLatestByStudentAndQuestionIds(7, []);
    expect(m.size).toBe(0);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('按 MAX(id) 取每题最近一次自评，返回 questionId -> assessment 映射', async () => {
    const pool = mockPool([
      { question_id: 10, assessment: 'incorrect' },
      { question_id: 12, assessment: 'correct' },
    ]);
    const repo = new QuestionSelfAssessmentsRepository(pool as any);
    const m = await repo.findLatestByStudentAndQuestionIds(7, [10, 11, 12]);
    expect(m.get(10)).toBe('incorrect');
    expect(m.get(11)).toBeUndefined();
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('MAX(id)');
    expect(sql).toContain('student_id = ?');
    expect(params).toEqual([7, 10, 11, 12]);
  });
});
