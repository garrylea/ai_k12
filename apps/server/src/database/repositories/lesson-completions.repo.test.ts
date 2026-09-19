import { describe, it, expect, vi } from 'vitest';
import { LessonCompletionsRepository } from './lesson-completions.repo.js';

const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([[], []]),
  query: vi.fn().mockResolvedValue([[], []]),
});

/**
 * 列清单 ↔ VALUES 逐位配对（与 `goals.repo.test.ts` 同款，复制过来避免跨文件依赖）。
 *
 * 位置断言（`expect(params).toEqual([...])`）只能证明「代码与它自己一致」，
 * 拦不住列错位——2026-09-22 就在 goals.repo 上栽过（title/period 对调落库）。
 */
function zipInsert(sql: string, params: unknown[]): Record<string, unknown> {
  const cols = sql
    .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
    .split(',')
    .map((c) => c.trim());
  const valuesRaw = sql.slice(sql.indexOf('VALUES (') + 'VALUES ('.length);
  const tokens = valuesRaw
    .slice(0, valuesRaw.indexOf(')'))
    .split(',')
    .map((t) => t.trim());

  const out: Record<string, unknown> = {};
  let pi = 0;
  tokens.forEach((tok, i) => {
    const col = cols[i];
    if (col === undefined) return;
    if (tok === '?') out[col] = params[pi++];
    else if (/^NULL$/i.test(tok)) out[col] = null;
    else if (/^\d+$/.test(tok)) out[col] = Number(tok);
    else out[col] = tok.replace(/^'|'$/g, '');
  });
  return out;
}

describe('LessonCompletionsRepository', () => {
  it('recordCompletion：INSERT IGNORE（同课重复完成要静默跳过），列与值逐位对应', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ insertId: 5 }, []]);
    const repo = new LessonCompletionsRepository(pool as any);

    await repo.recordCompletion({ studentId: 7, subjectId: 1, lessonId: 1113 });

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT IGNORE INTO lesson_completions');
    expect(zipInsert(sql as string, params as unknown[])).toEqual({
      student_id: 7,
      subject_id: 1,
      lesson_id: 1113,
    });
  });

  it('countInWindow：按学科 + 窗口计数（半开区间、不用 CURDATE）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: '3' }], []]);
    const repo = new LessonCompletionsRepository(pool as any);

    expect(await repo.countInWindow(7, 1, new Date('2026-09-14'), new Date('2026-09-21'))).toBe(3);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('subject_id = ?');
    expect(sql).toContain('completed_at >= ? AND completed_at < ?');
    expect(sql).not.toContain('CURDATE()');
    expect(params).toEqual([7, 1, new Date('2026-09-14'), new Date('2026-09-21')]);
  });

  it('countInWindow：无数据返回 0（不是 null）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: null }], []]);
    const repo = new LessonCompletionsRepository(pool as any);

    expect(await repo.countInWindow(7, 1, new Date(), new Date())).toBe(0);
  });
});
