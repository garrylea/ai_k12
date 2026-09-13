import { describe, it, expect, vi } from 'vitest';
import { DictationPassagesRepository } from './dictation-passages.repo';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('DictationPassagesRepository', () => {
  it('findVerifiedBySubject：只出 verified=1 且题未停用，按 sort_order 排序', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.findVerifiedBySubject(2);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM dictation_passages dp');
    expect(sql).toContain('JOIN questions q ON q.id = dp.question_id');
    expect(sql).toContain('dp.verified = 1');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain('q.subject_id = ?');
    expect(sql).toContain('ORDER BY dp.sort_order');
    expect(params).toEqual([2]);
  });

  it('findRandomVerified：排除已标记不再展示的题，带 LIMIT 与册次过滤', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.findRandomVerified(7, 2, '上册', 5);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('LEFT JOIN student_hidden_questions shq');
    expect(sql).toContain('shq.question_id = dp.question_id AND shq.student_id = ?');
    expect(sql).toContain('shq.id IS NULL');
    expect(sql).toContain('dp.semester = ?');
    expect(sql).toContain('ORDER BY RAND()');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual([7, 2, '上册', 5]);
  });

  it('findRandomVerified：semester=null 时不含册次过滤', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.findRandomVerified(7, 2, null, 5);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('dp.semester = ?');
    expect(params).toEqual([7, 2, 5]);
  });

  it('findVerifiedByQuestionIds：空数组直接返回空，不查库', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    const rows = await repo.findVerifiedByQuestionIds(2, []);
    expect(rows).toEqual([]);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('upsert：按 (work_title, semester) 业务主键 upsert', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.upsert({
      questionId: 100, workTitle: '静夜思', author: '李白', dynasty: '唐',
      body: '床前明月光', gradeBand: 'junior', grade: '九年级', semester: '上册',
      sortOrder: 1, sourceRef: 'DEV-FIXTURE', verified: 0,
    });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO dictation_passages');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('work_title');
    expect(params[0]).toBe(100);
  });
});
