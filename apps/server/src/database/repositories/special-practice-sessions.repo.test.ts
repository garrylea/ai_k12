import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpecialPracticeSessionsRepository } from './special-practice-sessions.repo.js';

// 复用现有 mockPool 模式（见 special-practice-logs.repo.test.ts）
function mockPool() {
  const execute = vi.fn();
  return { execute, query: execute } as any;
}

describe('SpecialPracticeSessionsRepository', () => {
  afterEach(() => vi.clearAllMocks());

  it('upsertSession 首次调用 INSERT IGNORE 并返回 insertId', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ insertId: 42, affectedRows: 1 } as any]);
    const repo = new SpecialPracticeSessionsRepository(pool as any);
    const id = await repo.upsertSession({
      sessionUid: 'abc-123',
      studentId: 7,
      subjectId: 1,
      module: 'math_targeted',
      title: '数学薄弱点训练',
      questionCount: 3,
    });
    expect(id).toBe(42);
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT IGNORE INTO special_practice_sessions'),
      expect.arrayContaining(['abc-123', 7, 1, 'math_targeted']),
    );
  });

  it('upsertSession 命中已存在行时通过 SELECT 取 id（affectedRows=0 分支）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ insertId: 0, affectedRows: 0 } as any]);
    pool.execute.mockResolvedValueOnce([[{ id: 99 }] as any]);
    const repo = new SpecialPracticeSessionsRepository(pool as any);
    const id = await repo.upsertSession({
      sessionUid: 'abc-123', studentId: 7, subjectId: 1, module: 'math_targeted', title: null, questionCount: 0,
    });
    expect(id).toBe(99);
  });
});
