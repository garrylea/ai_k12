import { describe, it, expect, vi } from 'vitest';
import { MainErrorBooksRepository } from './main-error-books.repo';

/**
 * mockPool 模拟 mysql2 的 pool.execute 双返回形状：
 * - INSERT -> [ResultSetHeader, fields]
 * - UPDATE -> [ResultSetHeader, fields]
 * - SELECT -> [rows[], fields]
 */
const mockPool = (rows: any[] = [], insertId = 7) => ({
  execute: vi.fn().mockImplementation((sql: string) => {
    const trimmed = sql.trim();
    if (/^INSERT/i.test(trimmed)) {
      return Promise.resolve([{ insertId, affectedRows: 1 }, []]);
    }
    if (/^UPDATE/i.test(trimmed)) {
      return Promise.resolve([{ affectedRows: 1, changedRows: 1 }, []]);
    }
    return Promise.resolve([rows, []]);
  }),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('MainErrorBooksRepository', () => {
  it('create 插入并返回 id', async () => {
    const pool = mockPool();
    const repo = new MainErrorBooksRepository(pool as any);
    const id = await repo.create({
      student_id: 1,
      subject_id: 1,
      question_id: 2,
      source: 'practice',
      source_ref_id: 3,
      wrong_answer_text: null,
    });
    expect(id).toBe(7);
    // 校验 SQL 含 source_ref_id 列（main_error_books 独有）
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('source_ref_id');
    expect(params).toEqual([1, 1, 2, 'practice', 3, null]);
  });

  it('create 接受 question_id=null（质量差仅存题面）', async () => {
    const repo = new MainErrorBooksRepository(mockPool() as any);
    const id = await repo.create({
      student_id: 1,
      subject_id: 1,
      question_id: null,
      source: 'practice',
      source_ref_id: 3,
      wrong_answer_text: '原始题面',
    });
    expect(id).toBe(7);
  });

  it('findById 返回首行，无则 null', async () => {
    const row = { id: 5, student_id: 1, subject_id: 1, question_id: 2 };
    const repo = new MainErrorBooksRepository(mockPool([row]) as any);
    const found = await repo.findById(5);
    expect(found).toEqual(row);

    const repoEmpty = new MainErrorBooksRepository(mockPool([]) as any);
    const notFound = await repoEmpty.findById(999);
    expect(notFound).toBeNull();
  });

  it('findByStudent 默认排除已清除且按 id DESC', async () => {
    const pool = mockPool([{ id: 1 }]);
    const repo = new MainErrorBooksRepository(pool as any);
    await repo.findByStudent(10);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('student_id = ?');
    expect(sql).toContain('is_cleared = 0');
    expect(sql).not.toContain('subject_id = ?');
    expect(sql).toContain('ORDER BY id DESC');
    expect(params).toEqual([10]);
  });

  it('findByStudent 带 subjectId 且 includeCleared=true', async () => {
    const pool = mockPool([]);
    const repo = new MainErrorBooksRepository(pool as any);
    await repo.findByStudent(10, 2, true);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('subject_id = ?');
    expect(sql).not.toContain('is_cleared = 0'); // includeCleared 跳过
    expect(params).toEqual([10, 2]);
  });

  it('markCleared 更新 is_cleared=1 并设 cleared_at', async () => {
    const pool = mockPool();
    const repo = new MainErrorBooksRepository(pool as any);
    await repo.markCleared(42);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('is_cleared = 1');
    expect(sql).toContain('cleared_at = NOW(3)');
    expect(params).toEqual([42]);
  });
});
