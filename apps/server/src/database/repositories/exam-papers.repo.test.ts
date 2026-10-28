import { describe, expect, it, vi } from 'vitest';
import { ExamPapersRepository } from './exam-papers.repo';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
});

describe('ExamPapersRepository.findQuestionsByPaperId', () => {
  it('只取进考试（in_exam=1）且激活的题，并带同节材料 materialText', async () => {
    const pool = mockPool([]);
    const repo = new ExamPapersRepository(pool as any);

    await repo.findQuestionsByPaperId(17);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('q.material_text AS materialText');
    expect(sql).toContain('q.is_active = 1');
    // 语文首期剔除阅读/作文靠显式标记，不能靠「有没有 material_text」猜
    expect(sql).toContain('pq.in_exam = 1');
    expect(params).toEqual([17]);
  });
});

describe('ExamPapersRepository.findPapers', () => {
  it('question_count 改为「进考试且激活」的可考题目数（列表显示 16 而不是 27）', async () => {
    const pool = mockPool([]);
    const repo = new ExamPapersRepository(pool as any);

    await repo.findPapers({ subjectId: 2 });

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain('pq.in_exam = 1');
    expect(sql).toContain('q.is_active = 1');
    // 加了表别名后筛选列必须带前缀，否则 MySQL 报 ambiguous
    expect(sql).toContain('p.subject_id = ?');
    expect(params).toEqual([2]);
  });
});
