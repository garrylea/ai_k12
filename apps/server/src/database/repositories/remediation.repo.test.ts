import { describe, it, expect, vi } from 'vitest';
import { RemediationRepository } from './remediation.repo';

/** mockPool：execute 走 prepared statement —— SELECT 返回 [rows, []]，
 *  INSERT/UPDATE/DELETE 返回 [ResultSetHeader, []]。 */
const mockPool = (rows: any[] = [], affected = 0, insertId = 0) => ({
  execute: vi.fn().mockImplementation((sql: string) => {
    return Promise.resolve(
      sql.trim().toUpperCase().startsWith('SELECT')
        ? [rows, []]
        : [{ affectedRows: affected, insertId }, []],
    ) as any;
  }),
});

describe('RemediationRepository.findActiveByStudent', () => {
  it('无 active 套题时返回 null，参数 (studentId, subjectId)', async () => {
    const pool = mockPool([], 0);
    const repo = new RemediationRepository(pool as any);
    const r = await repo.findActiveByStudent(7, 1);
    expect(r).toBeNull();
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM remediation_sets');
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('ORDER BY id DESC LIMIT 1');
    expect(params).toEqual([7, 1]);
  });

  it('命中时返回首行', async () => {
    const row = { id: 3, student_id: 7, subject_id: 1, status: 'active' };
    const pool = mockPool([row]);
    const repo = new RemediationRepository(pool as any);
    expect(await repo.findActiveByStudent(7, 1)).toEqual(row);
  });
});

describe('RemediationRepository.findOrCreateActiveSet', () => {
  it('已有 active 套题 → 返回既有 id 且 created=false，不 INSERT', async () => {
    const row = { id: 3, student_id: 7, subject_id: 1, status: 'active' };
    const pool = mockPool([row]);
    const repo = new RemediationRepository(pool as any);

    expect(await repo.findOrCreateActiveSet(7, 1)).toEqual({ id: 3, created: false });
    expect(pool.execute).toHaveBeenCalledTimes(1); // 只有那一次 SELECT
  });

  it('没有 active 套题 → INSERT 并返回 created=true', async () => {
    const pool = mockPool([], 1, 42);
    const repo = new RemediationRepository(pool as any);

    expect(await repo.findOrCreateActiveSet(7, 1)).toEqual({ id: 42, created: true });
    const [sql, params] = pool.execute.mock.calls[1];
    expect(sql).toContain('INSERT INTO remediation_sets (student_id, subject_id)');
    expect(params).toEqual([7, 1]);
  });

  it('并发：INSERT 撞 uniq_rsets_active（ER_DUP_ENTRY）→ 回查赢家的套题，created=false', async () => {
    const winner = { id: 9, student_id: 7, subject_id: 1, status: 'active' };
    let call = 0;
    const pool = {
      execute: vi.fn().mockImplementation((sql: string) => {
        const upper = sql.trim().toUpperCase();
        if (upper.startsWith('SELECT')) {
          call++;
          // 第一次 SELECT 落空（并发对手还没提交），撞键后回查命中赢家
          return Promise.resolve([call === 1 ? [] : [winner], []]) as any;
        }
        return Promise.reject(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' })) as any;
      }),
    };
    const repo = new RemediationRepository(pool as any);

    expect(await repo.findOrCreateActiveSet(7, 1)).toEqual({ id: 9, created: false });
  });

  it('非撞键错误（如连接断开）原样抛出，不被吞掉', async () => {
    const pool = {
      execute: vi.fn().mockImplementation((sql: string) => {
        if (sql.trim().toUpperCase().startsWith('SELECT')) return Promise.resolve([[], []]) as any;
        return Promise.reject(Object.assign(new Error('boom'), { code: 'ECONNRESET' })) as any;
      }),
    };
    const repo = new RemediationRepository(pool as any);

    await expect(repo.findOrCreateActiveSet(7, 1)).rejects.toThrow('boom');
  });
});

describe('RemediationRepository.insertItems', () => {
  it('INSERT IGNORE 多值拼参为 (groupId, qid) 展平，返回 affectedRows', async () => {
    const pool = mockPool([], 1);
    const repo = new RemediationRepository(pool as any);
    const n = await repo.insertItems(5, [10, 11, 12]);
    expect(n).toBe(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT IGNORE INTO remediation_set_items (group_id, question_id)');
    expect(sql).toContain('VALUES (?, ?),(?, ?),(?, ?)');
    expect(params).toEqual([5, 10, 5, 11, 5, 12]);
  });

  it('空数组直接返回 0，不触库', async () => {
    const pool = mockPool([], 0);
    const repo = new RemediationRepository(pool as any);
    expect(await repo.insertItems(5, [])).toBe(0);
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

describe('RemediationRepository.findItemBySetQuestion', () => {
  it('无命中返回 null，JOIN groups 限 set 归属，参数 (setId, questionId)', async () => {
    const pool = mockPool([]);
    const repo = new RemediationRepository(pool as any);
    expect(await repo.findItemBySetQuestion(3, 10)).toBeNull();
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM remediation_set_items i');
    expect(sql).toContain('JOIN remediation_groups g ON g.id = i.group_id');
    expect(sql).toContain('g.set_id = ?');
    expect(sql).toContain('i.question_id = ?');
    expect(params).toEqual([3, 10]);
  });
});

describe('RemediationRepository.deleteSet', () => {
  it('物理删除套题头（CASCADE 带走 groups/items）', async () => {
    const pool = mockPool([], 1);
    const repo = new RemediationRepository(pool as any);
    await repo.deleteSet(3);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('DELETE FROM remediation_sets WHERE id = ?');
    expect(params).toEqual([3]);
  });
});
