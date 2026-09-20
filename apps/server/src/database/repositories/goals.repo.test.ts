import { describe, it, expect, vi } from 'vitest';
import { GoalsRepository } from './goals.repo.js';

const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([[], []]),
  query: vi.fn().mockResolvedValue([[], []]),
});

/**
 * 把 INSERT 的**列清单**与 VALUES 逐位配对成对象，按列名断言。
 *
 * 为什么不直接断言 params 数组字面量：那只能证明「代码与它自己一致」。2026-09-22 实测栽过——
 * `ensureDefaults` 的参数顺序写成 `[studentId, metric, period, title, target]`，而列清单是
 * `(student_id, subject_id, metric, title, period, ...)`，于是 title 与 period 落库时对调
 * （库里成 `title='daily' / period='每日学习时长'`）。当时的位置断言照样全绿，端到端冒烟才抓到。
 * 按列名配对才能拦住「列错位」这一类错误。
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

describe('GoalsRepository', () => {
  it('ensureDefaults：必须用 INSERT IGNORE（否则会覆盖家长已设的值）', async () => {
    const pool = mockPool();
    const repo = new GoalsRepository(pool as any);

    await repo.ensureDefaults(11, [
      { subjectId: 1, metric: 'daily_study_minutes', period: 'daily', title: '每日学习时长', target: 30 },
      { subjectId: 1, metric: 'weekly_lessons', period: 'weekly', title: '每周完课', target: 2 },
    ]);

    expect(pool.execute).toHaveBeenCalledTimes(2);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT IGNORE INTO goals');
    expect(sql).not.toContain('ON DUPLICATE KEY UPDATE');
  });

  it('ensureDefaults：subject/title/period 各就各位（按列名配对断言，别退回位置断言）', async () => {
    const pool = mockPool();
    const repo = new GoalsRepository(pool as any);

    await repo.ensureDefaults(11, [
      { subjectId: 1, metric: 'daily_study_minutes', period: 'daily', title: '每日学习时长', target: 30 },
    ]);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(zipInsert(sql as string, params as unknown[])).toEqual({
      student_id: 11,
      subject_id: 1,
      metric: 'daily_study_minutes',
      title: '每日学习时长',
      period: 'daily',
      target_value: 30,
      reminder_enabled: 0,
      is_active: 1,
    });
  });

  it('ensureDefaults：**同一个 metric 可以在不同学科各建一行**（按学科后 metric 不再唯一）', async () => {
    const pool = mockPool();
    const repo = new GoalsRepository(pool as any);

    await repo.ensureDefaults(11, [
      { subjectId: 1, metric: 'daily_study_minutes', period: 'daily', title: '每日学习时长', target: 30 },
      { subjectId: 2, metric: 'daily_study_minutes', period: 'daily', title: '每日学习时长', target: 30 },
    ]);

    expect(pool.execute).toHaveBeenCalledTimes(2);
    const first = zipInsert(
      pool.execute.mock.calls[0][0] as string,
      pool.execute.mock.calls[0][1] as unknown[],
    );
    const second = zipInsert(
      pool.execute.mock.calls[1][0] as string,
      pool.execute.mock.calls[1][1] as unknown[],
    );
    expect(first.subject_id).toBe(1);
    expect(second.subject_id).toBe(2);
    expect(first.metric).toBe(second.metric);
  });

  it('ensureDefaults：空数组不发任何 SQL', async () => {
    const pool = mockPool();
    const repo = new GoalsRepository(pool as any);

    await repo.ensureDefaults(11, []);

    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('upsertTarget：ON DUPLICATE KEY UPDATE 更新目标值并把 is_active 置回 1', async () => {
    const pool = mockPool();
    const repo = new GoalsRepository(pool as any);

    await repo.upsertTarget(11, 2, 'weekly_passages', 'weekly', '每周古诗文篇目', 8);

    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO goals');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('target_value = new.target_value');
    expect(sql).toContain('is_active    = 1');
    // 提醒本期不做（2026-09-20 用户裁决）：写入一律把 reminder_enabled 固定成 0，
    // 且不得出现 `reminder_enabled = ` 这种「把它当可改字段」的写法。
    expect(sql).toContain('0, 1)');
    expect(sql).not.toContain('reminder_enabled = ');
  });

  it('upsertTarget：subject/title/period 不串列（与 ensureDefaults 同一个坑）', async () => {
    const pool = mockPool();
    const repo = new GoalsRepository(pool as any);

    await repo.upsertTarget(11, 2, 'weekly_passages', 'weekly', '每周古诗文篇目', 8);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(zipInsert(sql as string, params as unknown[])).toEqual({
      student_id: 11,
      subject_id: 2,
      metric: 'weekly_passages',
      title: '每周古诗文篇目',
      period: 'weekly',
      target_value: 8,
      reminder_enabled: 0,
      is_active: 1,
    });
  });

  it('findActiveByStudent：只取 is_active=1，返回 camelCase（含 subjectId）且 Number() 化', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([
      [{ id: 7, subject_id: 3, metric: 'daily_words', period: 'daily', target_value: '20', title: '每日背单词' }],
      [],
    ]);
    const repo = new GoalsRepository(pool as any);

    const rows = await repo.findActiveByStudent(11);

    expect(rows).toEqual([
      { id: 7, subjectId: 3, metric: 'daily_words', period: 'daily', targetValue: 20, title: '每日背单词' },
    ]);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('is_active = 1');
    expect(sql).toContain('ORDER BY subject_id, id');
    expect(params).toEqual([11]);
  });

  it('findActiveByStudent：subject_id 为 NULL 的历史行原样返回 null（由调用方跳过）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([
      [{ id: 9, subject_id: null, metric: 'daily_words', period: 'daily', target_value: 20, title: '每日背单词' }],
      [],
    ]);
    const repo = new GoalsRepository(pool as any);

    const rows = await repo.findActiveByStudent(11);

    expect(rows[0].subjectId).toBeNull();
  });
});
