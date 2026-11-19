import { describe, expect, it, vi } from 'vitest';
import { ContentAuditRepository } from './content-audit.repo.js';

function mockPool() {
  return {
    execute: vi.fn().mockResolvedValue([[{ total: 7 }], []]),
    query: vi.fn().mockResolvedValue([[], []]),
  };
}

describe('ContentAuditRepository.append', () => {
  it('写审计行：JSON 字段序列化，缺省字段落 NULL', async () => {
    const pool = mockPool();
    const repo = new ContentAuditRepository(pool as any);

    await repo.append({
      actorId: 7, actorRole: 'researcher', actorName: '教研员',
      action: 'paper.delete', targetType: 'paper', targetId: 42, paperId: 42,
      beforeJson: { title: '旧卷' },
    });

    expect(pool.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO content_audit_logs');
    expect(params).toEqual([
      7, 'researcher', '教研员', 'paper.delete', 'paper', 42, 42,
      '{"title":"旧卷"}', null, null,
    ]);
  });

  it('appendOnConnection 走传入的连接而非 pool（保证同事务）', async () => {
    const pool = mockPool();
    const conn = { execute: vi.fn().mockResolvedValue(undefined) };
    const repo = new ContentAuditRepository(pool as any);

    await repo.appendOnConnection(conn as any, {
      actorId: 7, actorRole: 'researcher', actorName: null,
      action: 'paper.delete', targetType: 'paper', targetId: 42, paperId: 42,
    });

    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(pool.execute).not.toHaveBeenCalled();
    const [sql, params] = conn.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO content_audit_logs');
    expect(params).toEqual([
      7, 'researcher', null, 'paper.delete', 'paper', 42, 42, null, null, null,
    ]);
  });
});

describe('ContentAuditRepository.findAll', () => {
  it('双边时间用 BETWEEN，筛选落到 WHERE，分页走 query', async () => {
    const pool = mockPool();
    const repo = new ContentAuditRepository(pool as any);
    const from = new Date('2026-11-01T00:00:00.000Z');
    const to = new Date('2026-11-19T23:59:59.999Z');

    const out = await repo.findAll({
      actorId: 7, action: 'paper.delete', targetType: 'paper', targetId: 42,
      from, to, page: 2, pageSize: 20,
    });

    expect(out.total).toBe(7);
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('created_at BETWEEN ? AND ?');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).toContain('LIMIT ? OFFSET ?');
    expect(params).toEqual([7, 'paper.delete', 'paper', 42, from, to, 20, 20]);
    expect(pool.execute.mock.calls[0][0]).toContain('COUNT(*) AS total');
  });

  it('无筛选时不带 WHERE（除分页）', async () => {
    const pool = mockPool();
    const repo = new ContentAuditRepository(pool as any);

    await repo.findAll({ page: 1, pageSize: 20 });

    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([20, 0]);
  });
});
