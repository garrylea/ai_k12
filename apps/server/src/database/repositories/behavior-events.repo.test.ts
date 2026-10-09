import { describe, expect, it, vi } from 'vitest';
import { BehaviorEventsRepository } from './behavior-events.repo.js';

function makePool() {
  return { query: vi.fn(async () => [[]]) } as any;
}

describe('BehaviorEventsRepository', () => {
  it('insertMany 走 pool.query（不用 execute）且按列名配对占位符', async () => {
    const pool = makePool();
    const repo = new BehaviorEventsRepository(pool);
    await repo.insertMany([
      { actor_role: 'student', student_id: 7, event: 'answer_submitted', tier: 'parent', source: 'server' },
      { actor_role: 'student', student_id: 7, event: 'page_view', tier: 'ops', source: 'client', props: JSON.stringify({ route: '/x' }) },
    ] as any);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO behavior_events');
    // 列清单与 VALUES 占位符数量一致（2 行 × 14 列）
    expect(sql.match(/\?/g)!.length).toBe(28);
    expect(params).toHaveLength(28);
    expect(params).toContain('answer_submitted');
  });

  it('空数组直接返回不执行 SQL', async () => {
    const pool = makePool();
    await new BehaviorEventsRepository(pool).insertMany([]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
