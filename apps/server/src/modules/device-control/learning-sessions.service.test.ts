import { describe, it, expect, vi } from 'vitest';
import { LearningSessionsService } from './learning-sessions.service.js';
import type { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import type { ControlsRepository } from '../../database/repositories/controls.repo.js';

const mkSessionsRepo = () => ({
  findOpen: vi.fn().mockResolvedValue(null),
  insertOpen: vi.fn(),
  touch: vi.fn().mockResolvedValue(undefined),
  endById: vi.fn().mockResolvedValue(undefined),
  findByIdForStudent: vi.fn().mockResolvedValue(null),
  pollAndConsume: vi.fn().mockResolvedValue({ commands: [], openSession: null }),
});

const mkControlsRepo = (lockMinutes: number | null) =>
  ({ findSessionLockMinutes: vi.fn().mockResolvedValue(lockMinutes) } as unknown as ControlsRepository);

const mkSvc = (
  sessions: ReturnType<typeof mkSessionsRepo>,
  controls: ControlsRepository,
) => new LearningSessionsService(sessions as unknown as LearningSessionsRepository, controls);

const ROW = (over: Record<string, unknown> = {}) => ({
  id: 7,
  student_id: 9,
  app_shell: 'electron',
  started_at: new Date('2026-09-23T01:00:00.000Z'),
  last_seen_at: new Date('2026-09-23T01:00:00.000Z'),
  ended_at: null,
  lock_minutes: 60,
  lock_expires_at: new Date('2026-09-23T02:00:00.000Z'),
  unlocked_at: null,
  unlocked_by_parent_id: null,
  ...over,
});

describe('LearningSessionsService.openOrGet（spec §5.1）', () => {
  it('已有进行中会话 → 原样返回，**不新建、不改 lock_expires_at**（重启不重置时钟）', async () => {
    const sessions = mkSessionsRepo();
    // 关键：这次 findOpen 命中的行，lock_expires_at 是一小时前算好的那个值
    (sessions.findOpen as any).mockResolvedValue(ROW());

    const out = await mkSvc(sessions, mkControlsRepo(60)).openOrGet(9);

    expect(out.id).toBe(7);
    expect(out.lockExpiresAt).toBe('2026-09-23T02:00:00.000Z');
    expect(sessions.insertOpen).not.toHaveBeenCalled();
    // 顺带刷新 last_seen_at（重启也算「还活着」）
    expect(sessions.touch).toHaveBeenCalledWith(9);
  });

  it('无进行中会话 + 家长设了锁 → 新建并快照 lock_minutes', async () => {
    const sessions = mkSessionsRepo();
    (sessions.insertOpen as any).mockResolvedValue(ROW({ lock_expires_at: new Date('2026-09-23T02:00:00.000Z') }));

    const out = await mkSvc(sessions, mkControlsRepo(60)).openOrGet(9);

    expect(sessions.insertOpen).toHaveBeenCalledWith({
      studentId: 9,
      appShell: 'electron',
      lockMinutes: 60,
    });
    expect(out.lockMinutes).toBe(60);
    expect(out.lockExpiresAt).toBe('2026-09-23T02:00:00.000Z');
  });

  it('未设锁 → 新建但 lockMinutes / lockExpiresAt 皆为 null（学生可自由登出）', async () => {
    const sessions = mkSessionsRepo();
    (sessions.insertOpen as any).mockResolvedValue(
      ROW({ lock_minutes: null, lock_expires_at: null }),
    );

    const out = await mkSvc(sessions, mkControlsRepo(null)).openOrGet(9);

    expect(sessions.insertOpen).toHaveBeenCalledWith({
      studentId: 9,
      appShell: 'electron',
      lockMinutes: null,
    });
    expect(out.lockMinutes).toBeNull();
    expect(out.lockExpiresAt).toBeNull();
  });
});

describe('LearningSessionsService.end（spec §5.2）', () => {
  it('不属于该生的 id → 404/1002（不复用 403，避免泄露「该 id 存在」）', async () => {
    const sessions = mkSessionsRepo();
    (sessions.findByIdForStudent as any).mockResolvedValue(null);

    await expect(mkSvc(sessions, mkControlsRepo(null)).end(9, 123)).rejects.toMatchObject({
      status: 404,
      response: { code: 1002 },
    });
    expect(sessions.endById).not.toHaveBeenCalled();
  });

  it('已结束的会话再调 → 幂等，回原 endedAt，不重复写库', async () => {
    const sessions = mkSessionsRepo();
    (sessions.findByIdForStudent as any).mockResolvedValue(
      ROW({ ended_at: new Date('2026-09-23T01:30:00.000Z') }),
    );

    const out = await mkSvc(sessions, mkControlsRepo(null)).end(9, 7);

    expect(out.endedAt).toBe('2026-09-23T01:30:00.000Z');
    expect(sessions.endById).not.toHaveBeenCalled();
  });

  it('进行中 → 结束并回新时刻', async () => {
    const sessions = mkSessionsRepo();
    (sessions.findByIdForStudent as any)
      .mockResolvedValueOnce(ROW())
      .mockResolvedValueOnce(ROW({ ended_at: new Date('2026-09-23T01:45:00.000Z') }));

    const out = await mkSvc(sessions, mkControlsRepo(null)).end(9, 7);

    expect(sessions.endById).toHaveBeenCalledWith(7, 9);
    expect(out).toEqual({ id: 7, endedAt: '2026-09-23T01:45:00.000Z' });
  });
});

describe('LearningSessionsService.poll（spec §5.3）', () => {
  it('无进行中会话 → commands 空、lock 为 null（正常态，不是 404）', async () => {
    const sessions = mkSessionsRepo();
    (sessions.pollAndConsume as any).mockResolvedValue({ commands: [], openSession: null });

    const out = await mkSvc(sessions, mkControlsRepo(null)).poll(9);

    expect(out).toEqual({ commands: [], lock: null });
  });

  it('带回 lock 供客户端对账（服务端是唯一真源）', async () => {
    const sessions = mkSessionsRepo();
    (sessions.pollAndConsume as any).mockResolvedValue({ commands: [], openSession: ROW() });

    const out = await mkSvc(sessions, mkControlsRepo(null)).poll(9);

    expect(out.lock).toEqual({
      sessionId: 7,
      lockExpiresAt: '2026-09-23T02:00:00.000Z',
      unlockedAt: null,
    });
  });

  it('透传认领到的命令', async () => {
    const sessions = mkSessionsRepo();
    (sessions.pollAndConsume as any).mockResolvedValue({
      commands: [{ id: 3, command: 'unlock' }],
      openSession: ROW({ unlocked_at: new Date('2026-09-23T01:20:00.000Z') }),
    });

    const out = await mkSvc(sessions, mkControlsRepo(null)).poll(9);

    expect(out.commands).toEqual([{ id: 3, command: 'unlock' }]);
    expect(out.lock?.unlockedAt).toBe('2026-09-23T01:20:00.000Z');
  });
});
