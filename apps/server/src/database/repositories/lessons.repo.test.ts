import { describe, it, expect, vi } from 'vitest';
import { LessonsRepository } from './lessons.repo';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('LessonsRepository', () => {
  it('findById 返回首行，无则 null', async () => {
    const row = { id: 5, unit_id: 1, name: 'Lesson 5', sort_order: 2, is_unit_last: 0 };
    const repo = new LessonsRepository(mockPool([row]) as any);
    const found = await repo.findById(5);
    expect(found).toEqual({ id: 5, unitId: 1, name: 'Lesson 5', sortOrder: 2, isUnitLast: false });

    const repoEmpty = new LessonsRepository(mockPool([]) as any);
    const notFound = await repoEmpty.findById(999);
    expect(notFound).toBeNull();
  });

  it('findByUnitId 按 sort_order 排序返回', async () => {
    const rows = [
      { id: 1, unit_id: 1, name: 'L1', sort_order: 1, is_unit_last: 0 },
      { id: 2, unit_id: 1, name: 'L2', sort_order: 2, is_unit_last: 1 },
    ];
    const repo = new LessonsRepository(mockPool(rows) as any);
    const lessons = await repo.findByUnitId(1);
    expect(lessons).toHaveLength(2);
    expect(lessons[1].isUnitLast).toBe(true);
  });

  it('findPreviousLessonId 返回 CTE 查询结果', async () => {
    const pool = mockPool([{ prev_lesson_id: 42 }]);
    const repo = new LessonsRepository(pool as any);
    const prev = await repo.findPreviousLessonId(100);
    expect(prev).toBe(42);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('WITH current AS');
    expect(sql).toContain('prev_in_unit');
    expect(sql).toContain('prev_unit_last');
    expect(sql).toContain('textbook_versions');
    expect(params).toEqual([100]);
  });

  it('findPreviousLessonId 无上一课时返回 null', async () => {
    const repo = new LessonsRepository(mockPool([{ prev_lesson_id: null }]) as any);
    const prev = await repo.findPreviousLessonId(1);
    expect(prev).toBeNull();
  });
});
