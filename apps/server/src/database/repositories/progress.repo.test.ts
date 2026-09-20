import { describe, it, expect, vi } from 'vitest';
import { ProgressRepository } from './progress.repo.js';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
});

describe('ProgressRepository.findSubjectIdsByStudent（P6.5「在学学科」判据）', () => {
  it('去重 + 按 subject_id 升序（页面分组与目标排序依赖这个稳定顺序）', async () => {
    const pool = mockPool([{ subject_id: 1 }, { subject_id: 2 }, { subject_id: 3 }]);
    const repo = new ProgressRepository(pool as any);

    expect(await repo.findSubjectIdsByStudent(7)).toEqual([1, 2, 3]);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('SELECT DISTINCT subject_id FROM progress');
    expect(sql).toContain('ORDER BY subject_id');
    expect(params).toEqual([7]);
  });

  it('没有任何 progress 行 → 空数组（调用方据此「不建默认目标」）', async () => {
    const repo = new ProgressRepository(mockPool([]) as any);
    expect(await repo.findSubjectIdsByStudent(7)).toEqual([]);
  });
});
