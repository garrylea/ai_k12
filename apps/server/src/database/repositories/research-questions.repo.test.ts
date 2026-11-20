import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ResearchQuestionsRepository } from './research-questions.repo.js';

const AUDIT = {
  actorId: 7, actorRole: 'researcher', actorName: '教研员',
  action: 'question.update' as const, targetType: 'question' as const,
  targetId: 9, paperId: 42, beforeJson: { answer: 'D' }, afterJson: { answer: 'C' },
  note: '对照原卷',
};

function mockAudit(over: { fail?: boolean } = {}) {
  return {
    appendOnConnection: vi.fn().mockImplementation((_conn: unknown, _entry: unknown) => {
      if (over.fail) return Promise.reject(new Error('audit insert failed'));
      return Promise.resolve();
    }),
  };
}

function mkConn(over: Record<string, any> = {}) {
  const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
  return {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    execute,
    ...over,
  };
}

function mkRepo(pool: unknown, audit = mockAudit()) {
  return new ResearchQuestionsRepository(pool as any, audit as any);
}

describe('ResearchQuestionsRepository.findById / findPaperIdByQuestion', () => {
  it('findById 取五字段 + answer_verified/content_hash，不存在返回 null', async () => {
    const row = { id: 9, answer: 'D', answer_verified: 0, content: 'x', options: null, explanation: null, approach: null, content_hash: 'abc' };
    const pool = { execute: vi.fn().mockResolvedValue([[row], []]) };
    const repo = mkRepo(pool);

    expect(await repo.findById(9)).toEqual(row);
    expect(pool.execute.mock.calls[0][0]).toContain('WHERE id = ?');
    pool.execute.mockResolvedValueOnce([[], []]);
    expect(await repo.findById(999)).toBeNull();
  });

  it('findPaperIdByQuestion 反查任一 paper_questions，无则 null', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ paper_id: 42 }], []]) };
    const repo = mkRepo(pool);
    expect(await repo.findPaperIdByQuestion(9)).toBe(42);

    pool.execute.mockResolvedValueOnce([[], []]);
    expect(await repo.findPaperIdByQuestion(999)).toBeNull();
  });
});

describe('ResearchQuestionsRepository.updateWithAudit', () => {
  it('改 answer：UPDATE 带 answer_verified=1（字面量），参数顺序 [字段..., id]', async () => {
    const conn = mkConn();
    const audit = mockAudit();
    const repo = mkRepo({ getConnection: vi.fn().mockResolvedValue(conn) }, audit);

    await repo.updateWithAudit(9, { answer: 'C' }, true, AUDIT);

    const updateCall = conn.execute.mock.calls[0] as [string, unknown[]];
    expect(updateCall[0]).toBe('UPDATE questions SET answer = ?, answer_verified = 1 WHERE id = ?');
    // answer_verified=1 是 SQL 字面量，参数里只有字段值 + id（多塞 1 会让 id 绑错，静默丢更新）
    expect(updateCall[1]).toEqual(['C', 9]);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('不改 answer：SQL 不含 answer_verified，不动该列', async () => {
    const conn = mkConn();
    const repo = mkRepo({ getConnection: vi.fn().mockResolvedValue(conn) });

    await repo.updateWithAudit(9, { explanation: '新解析' }, false, AUDIT);

    const [sql, params] = conn.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toBe('UPDATE questions SET explanation = ? WHERE id = ?');
    expect(params).toEqual(['新解析', 9]);
  });

  it('空字段 → 400/1001，且不取连接', async () => {
    const getConnection = vi.fn();
    const repo = mkRepo({ getConnection });
    await expect(repo.updateWithAudit(9, {}, false, AUDIT))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('审计写在事务的同一 conn 上，且先于 commit', async () => {
    const conn = mkConn();
    const audit = mockAudit();
    const repo = mkRepo({ getConnection: vi.fn().mockResolvedValue(conn) }, audit);

    await repo.updateWithAudit(9, { answer: 'C' }, true, AUDIT);

    expect(audit.appendOnConnection).toHaveBeenCalledTimes(1);
    expect(audit.appendOnConnection.mock.calls[0][0]).toBe(conn);
    expect(audit.appendOnConnection.mock.invocationCallOrder[0])
      .toBeLessThan((conn.commit as any).mock.invocationCallOrder[0]);
  });

  it('审计插入失败 → 整笔回滚、不 commit，题目不改（UPDATE 已下发但被回滚）', async () => {
    const conn = mkConn();
    const audit = mockAudit({ fail: true });
    const repo = mkRepo({ getConnection: vi.fn().mockResolvedValue(conn) }, audit);

    await expect(repo.updateWithAudit(9, { answer: 'C' }, true, AUDIT))
      .rejects.toThrow('audit insert failed');

    expect(conn.execute.mock.calls.some((c) => String(c[0]).startsWith('UPDATE questions'))).toBe(true);
    expect(audit.appendOnConnection).toHaveBeenCalledWith(conn, expect.objectContaining({ action: 'question.update' }));
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('UPDATE 本身失败 → 回滚、不写审计、不 commit', async () => {
    const conn = mkConn({
      execute: vi.fn().mockRejectedValue(new Error('db down')),
    });
    const audit = mockAudit();
    const repo = mkRepo({ getConnection: vi.fn().mockResolvedValue(conn) }, audit);

    await expect(repo.updateWithAudit(9, { answer: 'C' }, true, AUDIT)).rejects.toThrow('db down');

    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(audit.appendOnConnection).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });
});
