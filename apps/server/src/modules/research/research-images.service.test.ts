import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import * as fs from 'node:fs/promises';
import { ResearchImagesService } from './research-images.service.js';

const URL_A = '/uploads/research/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';
const ACTOR = { sub: 7, role: 'researcher', name: '教研员' };

function row(over: Record<string, unknown> = {}) {
  return { id: 5, source: 'research', url: URL_A, ...over };
}

/** 空壳期用 any 构造，避免 RED 阶段 tsc 因构造参数/缺失 gc 方法报错。 */
function setup() {
  // 删行 + 审计同事务：getConnection 给出单条连接，DELETE/审计都走它。
  const conn = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  const pool = {
    execute: vi.fn().mockResolvedValue([[{ cnt: 0 }], []]),
    getConnection: vi.fn().mockResolvedValue(conn),
  };
  const filesRepo = {
    findByUrl: vi.fn().mockResolvedValue(row()),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteOnConnection: vi.fn().mockResolvedValue(undefined),
  };
  const audit = {
    append: vi.fn().mockResolvedValue(undefined),
    appendOnConnection: vi.fn().mockResolvedValue(undefined),
  };
  const service = new (ResearchImagesService as any)(pool, filesRepo, audit);
  return { service, pool, conn, filesRepo, audit };
}

beforeEach(() => {
  process.env.UPLOAD_DIR = '/tmp/ai-k12-research-images-test';
  vi.mocked(fs.unlink).mockReset();
  vi.mocked(fs.unlink).mockResolvedValue(undefined);
});

describe('ResearchImagesService.cleanupUnreferenced — 清理铁律', () => {
  it('铁律 2：questions 五列任一引用 → 跳过，不删 DB 行/磁盘', async () => {
    const { service, pool, filesRepo } = setup();
    pool.execute.mockResolvedValueOnce([[{ cnt: 1 }]]); // questions 仍被引用

    const res = await service.cleanupUnreferenced([URL_A], ACTOR);

    expect(res).toEqual({ deleted: 0, skipped: 1 });
    expect(filesRepo.deleteOnConnection).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM questions');
    for (const col of ['content', 'options', 'answer', 'explanation', 'approach']) {
      expect(sql).toContain(`${col} LIKE ?`);
    }
    expect(params).toEqual([`%${URL_A}%`, `%${URL_A}%`, `%${URL_A}%`, `%${URL_A}%`, `%${URL_A}%`]);
  });

  it('铁律 1+4：完全无引用 → 同事务删 DB 行 + 写 image.delete 审计，commit 后删磁盘', async () => {
    const { service, pool, conn, filesRepo, audit } = setup();
    pool.execute
      .mockResolvedValueOnce([[{ cnt: 0 }]]) // questions
      .mockResolvedValueOnce([[{ cnt: 0 }]]) // 学生作答三表
      .mockResolvedValueOnce([[{ cnt: 0 }]]); // extract_tasks

    const res = await service.cleanupUnreferenced([URL_A], ACTOR);

    // 删行与审计必须落在同一条连接上（spec §9.2）。
    expect(filesRepo.deleteOnConnection).toHaveBeenCalledWith(conn, 5);
    expect(audit.appendOnConnection).toHaveBeenCalledWith(conn, {
      actorId: 7, actorRole: 'researcher', actorName: '教研员',
      action: 'image.delete', targetType: 'image', targetId: 5,
    });
    expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(fs.unlink).toHaveBeenCalledWith('/tmp/ai-k12-research-images-test/research/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png');
    expect(res).toEqual({ deleted: 1, skipped: 0 });
  });

  it('铁律 2：学生作答三表任一引用 → 跳过，且 SQL 覆盖三表', async () => {
    const { service, pool, filesRepo } = setup();
    pool.execute
      .mockResolvedValueOnce([[{ cnt: 0 }]]) // questions
      .mockResolvedValueOnce([[{ cnt: 1 }]]); // exam_answers / answers / special_answer_records

    const res = await service.cleanupUnreferenced([URL_A], ACTOR);

    expect(res).toEqual({ deleted: 0, skipped: 1 });
    expect(filesRepo.deleteOnConnection).not.toHaveBeenCalled();
    const [sql, params] = pool.execute.mock.calls[1] as [string, unknown[]];
    for (const table of ['exam_answers', 'answers', 'special_answer_records']) {
      expect(sql).toContain(`FROM ${table}`);
    }
    expect(params).toEqual([`%${URL_A}%`, `%${URL_A}%`, `%${URL_A}%`]);
  });

  it('铁律 3：被 extract_tasks 引用 → 跳过，查询按 file_id', async () => {
    const { service, pool, filesRepo } = setup();
    pool.execute
      .mockResolvedValueOnce([[{ cnt: 0 }]])
      .mockResolvedValueOnce([[{ cnt: 0 }]])
      .mockResolvedValueOnce([[{ cnt: 1 }]]);

    const res = await service.cleanupUnreferenced([URL_A], ACTOR);

    expect(res).toEqual({ deleted: 0, skipped: 1 });
    expect(filesRepo.deleteOnConnection).not.toHaveBeenCalled();
    const [sql, params] = pool.execute.mock.calls[2] as [string, unknown[]];
    expect(sql).toContain('FROM extract_tasks');
    expect(sql).toContain('file_id = ?');
    expect(params).toEqual([5]);
  });

  it('铁律 1：findByUrl 无行或 source 非 research → 跳过（不误删学生图）', async () => {
    const missing = setup();
    missing.filesRepo.findByUrl.mockResolvedValue(null);
    expect(await missing.service.cleanupUnreferenced([URL_A], ACTOR))
      .toEqual({ deleted: 0, skipped: 1 });
    expect(missing.filesRepo.deleteOnConnection).not.toHaveBeenCalled();

    const foreign = setup();
    foreign.filesRepo.findByUrl.mockResolvedValue(row({ source: 'auxiliary' }));
    expect(await foreign.service.cleanupUnreferenced([URL_A], ACTOR))
      .toEqual({ deleted: 0, skipped: 1 });
    expect(foreign.filesRepo.deleteOnConnection).not.toHaveBeenCalled();
    expect(foreign.pool.execute).not.toHaveBeenCalled();
  });

  it('铁律 4：磁盘 unlink 失败只记日志，DB 已删仍算 deleted', async () => {
    const { service } = setup();
    vi.mocked(fs.unlink).mockRejectedValueOnce(new Error('EACCES'));

    const res = await service.cleanupUnreferenced([URL_A], ACTOR);

    expect(res).toEqual({ deleted: 1, skipped: 0 });
  });

  it('审计插入失败 → 整条 rollback：DB 行不删、磁盘不碰、记 skipped（spec §9.2）', async () => {
    const { service, conn, audit, filesRepo } = setup();
    audit.appendOnConnection.mockRejectedValueOnce(new Error('audit down'));

    const res = await service.cleanupUnreferenced([URL_A], ACTOR);

    expect(filesRepo.deleteOnConnection).toHaveBeenCalledWith(conn, 5);
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(res).toEqual({ deleted: 0, skipped: 1 });
  });

  it('rollback 自身失败也不吞掉原错误：整条仍记 skipped，不删磁盘', async () => {
    const { service, conn, audit } = setup();
    audit.appendOnConnection.mockRejectedValueOnce(new Error('audit down'));
    conn.rollback.mockRejectedValueOnce(new Error('rollback down'));

    const res = await service.cleanupUnreferenced([URL_A], ACTOR);

    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(res).toEqual({ deleted: 0, skipped: 1 });
  });

  it('引用扫描查询失败 → 吞掉并记 skipped，不抛到 post-commit 调用方', async () => {
    const { service, pool, filesRepo } = setup();
    pool.execute.mockRejectedValueOnce(new Error('db down'));

    const res = await service.cleanupUnreferenced([URL_A], ACTOR);

    expect(res).toEqual({ deleted: 0, skipped: 1 });
    expect(filesRepo.deleteOnConnection).not.toHaveBeenCalled();
  });

  it('整批预校验：含非法 URL 时 400 且在任何删除前拒绝（valid+invalid 不产生副作用）', async () => {
    const { service, filesRepo } = setup();
    const invalid = '/uploads/auxiliary/b.png';

    await expect(service.cleanupUnreferenced([URL_A, invalid], ACTOR))
      .rejects.toMatchObject({ status: 400 });
    expect(filesRepo.findByUrl).not.toHaveBeenCalled();
    expect(filesRepo.deleteOnConnection).not.toHaveBeenCalled();
  });

  it('无扩展名的 research URL（extension-less 上传）也可清理', async () => {
    const { service, conn, filesRepo } = setup();
    const noExt = '/uploads/research/cccccccc-dddd-eeee-ffff-000000000000';
    filesRepo.findByUrl.mockResolvedValue(row({ id: 6, url: noExt }));

    const res = await service.cleanupUnreferenced([noExt], ACTOR);

    expect(filesRepo.deleteOnConnection).toHaveBeenCalledWith(conn, 6);
    expect(fs.unlink).toHaveBeenCalledWith(
      '/tmp/ai-k12-research-images-test/research/cccccccc-dddd-eeee-ffff-000000000000',
    );
    expect(res.deleted).toBe(1);
  });

  it('重复 URL 去重：只查库/删一次', async () => {
    const { service, filesRepo } = setup();

    const res = await service.cleanupUnreferenced([URL_A, URL_A], ACTOR);

    expect(filesRepo.findByUrl).toHaveBeenCalledTimes(1);
    expect(filesRepo.deleteOnConnection).toHaveBeenCalledTimes(1);
    expect(res.deleted).toBe(1);
  });

  it.each([
    '/uploads/auxiliary/a.png',
    '/uploads/freeform/a.png',
    'images/a.png',
    '/uploads/research/../etc/passwd',
    `${URL_A}?x=1`,
  ])('非法 URL（非 research 或含路径穿越）→ 400/1001：%s', async (url) => {
    const { service } = setup();
    await expect(service.cleanupUnreferenced([url], ACTOR))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe('ResearchImagesService.gc', () => {
  it('扫 research 孤儿行，逐条走 cleanup，汇总 {scanned,deleted,skipped,failed}', async () => {
    const { service, pool } = setup();
    pool.execute.mockResolvedValueOnce([[{ url: URL_A }, { url: '/uploads/research/b.png' }], []]);
    const cleanup = vi.spyOn(service, 'cleanupUnreferenced')
      .mockResolvedValueOnce({ deleted: 1, skipped: 0 })
      .mockResolvedValueOnce({ deleted: 0, skipped: 1 });

    const res = await service.gc(48, ACTOR);

    expect(res).toEqual({ scanned: 2, deleted: 1, skipped: 1, failed: 0 });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenNthCalledWith(1, [URL_A], ACTOR);
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("source = 'research'");
    expect(sql).toContain('DATE_SUB');
    expect(params).toEqual([48]);
  });

  it('单条清理抛错 → failed++，不中断其余条目', async () => {
    const { service, pool } = setup();
    pool.execute.mockResolvedValueOnce([[{ url: URL_A }, { url: '/uploads/research/b.png' }], []]);
    vi.spyOn(service, 'cleanupUnreferenced')
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ deleted: 1, skipped: 0 });

    const res = await service.gc(24, ACTOR);

    expect(res).toEqual({ scanned: 2, deleted: 1, skipped: 0, failed: 1 });
  });

  it('无可扫描行 → 全 0', async () => {
    const { service, pool } = setup();
    pool.execute.mockResolvedValueOnce([[], []]);
    const cleanup = vi.spyOn(service, 'cleanupUnreferenced');

    expect(await service.gc(24, ACTOR)).toEqual({ scanned: 0, deleted: 0, skipped: 0, failed: 0 });
    expect(cleanup).not.toHaveBeenCalled();
  });
});
