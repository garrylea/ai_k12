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

  it('upsertSession 传 executor 时用该连接而非 pool', async () => {
    const pool = { execute: vi.fn(), query: vi.fn() };
    const exec = { execute: vi.fn().mockResolvedValue([{ insertId: 9, affectedRows: 1 }]), query: vi.fn() };
    const repo = new SpecialPracticeSessionsRepository(pool as any);
    await repo.upsertSession({ sessionUid: 'u', studentId: 1, subjectId: 1, module: 'math_targeted', title: null, questionCount: 0 }, exec as any);
    expect(pool.execute).not.toHaveBeenCalled();
    expect(exec.execute).toHaveBeenCalled();
  });

  it('markCompletedByUid 按 uid+student 置 completed_at 并返回 affectedRows', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 } as any]);
    const repo = new SpecialPracticeSessionsRepository(pool as any);
    expect(await repo.markCompletedByUid('u-1', 7)).toBe(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('UPDATE special_practice_sessions SET completed_at = NOW(3)');
    expect(sql).toContain('session_uid = ? AND student_id = ? AND completed_at IS NULL');
    expect(params).toEqual(['u-1', 7]);
  });

  it('markCompletedByUid 传 executor 时用该连接而非 pool', async () => {
    const pool = { execute: vi.fn(), query: vi.fn() };
    const exec = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }]), query: vi.fn() };
    const repo = new SpecialPracticeSessionsRepository(pool as any);
    expect(await repo.markCompletedByUid('u-1', 7, exec as any)).toBe(1);
    expect(pool.execute).not.toHaveBeenCalled();
    expect(exec.execute).toHaveBeenCalled();
  });

  it('findIdByUid 按 session_uid + student_id 取 id，传 executor 时用该连接', async () => {
    const pool = { execute: vi.fn(), query: vi.fn() };
    const exec = { execute: vi.fn().mockResolvedValue([[{ id: 101 }]]), query: vi.fn() };
    const repo = new SpecialPracticeSessionsRepository(pool as any);
    expect(await repo.findIdByUid('u-1', 7, exec as any)).toBe(101);
    expect(pool.execute).not.toHaveBeenCalled();
    const [sql, params] = exec.execute.mock.calls[0];
    expect(sql).toContain('SELECT id FROM special_practice_sessions WHERE session_uid = ? AND student_id = ?');
    expect(params).toEqual(['u-1', 7]);
  });

  it('findIdByUid 查无会话（含非本人）抛 409/1002', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[]] as any);
    const repo = new SpecialPracticeSessionsRepository(pool as any);
    await expect(repo.findIdByUid('u-1', 7)).rejects.toMatchObject({
      status: 409,
      response: { code: 1002, message: '作答记录不存在或已失效，请重新提交' },
    });
  });
});
