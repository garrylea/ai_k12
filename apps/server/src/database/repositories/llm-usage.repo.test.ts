import { describe, expect, it, vi } from 'vitest';
import { LlmUsageRepository } from './llm-usage.repo.js';

/** pool 只 mock query 本仓储用到的面。 */
function mkRepo(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue([rows, []]);
  const repo = new LlmUsageRepository({ query } as any);
  return { repo, query };
}

describe('LlmUsageRepository.aggregateByDay', () => {
  it('走 pool.query（GROUP BY 聚合形态，与 LIMIT ? 同一条仓规，不走 execute）', async () => {
    const { repo, query } = mkRepo([]);
    await repo.aggregateByDay(7, new Date('2026-09-01T00:00:00.000Z'), new Date('2026-10-01T00:00:00.000Z'));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('SQL 形状：JOIN students ON student_id（聚合范围=家长名下所有学生）+ tokens_unknown 独立计数 + 窗口参数', async () => {
    const { repo, query } = mkRepo([]);
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-10-01T00:00:00.000Z');
    await repo.aggregateByDay(7, start, end);

    const [sql, args] = query.mock.calls[0];
    expect(sql).toContain('FROM llm_call_logs l');
    expect(sql).toContain('JOIN students s ON l.student_id = s.id');
    expect(sql).toContain('s.parent_id = ?');
    expect(sql).toContain('l.created_at >= ?');
    expect(sql).toContain('l.created_at < ?');
    expect(sql).toContain('GROUP BY day');
    // NULL 语义仓规：NULL=量不到，绝不按 0 混入，单列独立计数
    expect(sql).toContain('SUM(l.input_tokens IS NULL OR l.output_tokens IS NULL) AS tokens_unknown');
    expect(args).toEqual([7, start, end]);
  });

  it('行数据透传（day 为 DATE_FORMAT 字符串，不经 mysql2 时区 Date 转换）', async () => {
    const rows = [{ day: '2026-10-01', calls: 3, input_tokens: 100, output_tokens: null, tokens_unknown: 1 }];
    const { repo } = mkRepo(rows);
    await expect(
      repo.aggregateByDay(7, new Date('2026-09-01T00:00:00.000Z'), new Date('2026-10-01T00:00:00.000Z')),
    ).resolves.toBe(rows);
  });
});
