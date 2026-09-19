import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { StudySessionsService } from './study-sessions.service.js';
import type { StudySessionsRepository, StudySessionRow } from '../../database/repositories/study-sessions.repo.js';
import type { SubjectsRepository } from '../../database/repositories/subjects.repo.js';

const MAC_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function makeRepo(overrides: Partial<StudySessionsRepository> = {}) {
  return {
    findByUid: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(true),
    heartbeat: vi.fn().mockResolvedValue(60),
    end: vi.fn().mockResolvedValue({ activeSeconds: 90, endedAt: new Date('2026-09-19T10:00:00Z') }),
    closeStale: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as StudySessionsRepository;
}

function makeSubjects(ids: number[] = [1, 2, 3]) {
  return { findAll: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))) } as unknown as SubjectsRepository;
}

const baseInput = () => ({
  studentId: 9,
  sessionUid: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  module: 'training_targeted',
  scene: 'targeted_run',
  userAgent: MAC_CHROME_UA,
});

describe('StudySessionsService.start', () => {
  let repo: StudySessionsRepository;

  beforeEach(() => {
    repo = makeRepo();
  });

  it('新建：解析 UA + 落库，返回 startedAt', async () => {
    const service = new StudySessionsService(repo, makeSubjects());
    const out = await service.start({ ...baseInput(), inputType: 'mouse', screenClass: 'desktop' });

    expect(out.sessionUid).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    expect(out.startedAt).toBeInstanceOf(Date);
    const arg = (repo.insert as any).mock.calls[0][0];
    expect(arg.platformClass).toBe('mac');
    expect(arg.browser).toBe('chrome');
    expect(arg.inputType).toBe('mouse');
    expect(arg.screenClass).toBe('desktop');
  });

  it('iPad 校正：Macintosh UA + input_type=touch → platform_class=ipad', async () => {
    const service = new StudySessionsService(repo, makeSubjects());
    await service.start({ ...baseInput(), inputType: 'touch' });
    expect((repo.insert as any).mock.calls[0][0].platformClass).toBe('ipad');
  });

  it('Macintosh UA + input_type=mouse → 仍是 mac（不误判）', async () => {
    const service = new StudySessionsService(repo, makeSubjects());
    await service.start({ ...baseInput(), inputType: 'mouse' });
    expect((repo.insert as any).mock.calls[0][0].platformClass).toBe('mac');
  });

  it('设备字段非法 → 存 NULL，不报错（设备信息是尽力而为）', async () => {
    const service = new StudySessionsService(repo, makeSubjects());
    await service.start({ ...baseInput(), screenClass: 'nintendo-switch', inputType: 'wand', appShell: 'wechat' });
    const arg = (repo.insert as any).mock.calls[0][0];
    expect(arg.screenClass).toBeNull();
    expect(arg.inputType).toBeNull();
    expect(arg.appShell).toBeNull();
  });

  it('sessionUid 非 UUID → 1001', async () => {
    const service = new StudySessionsService(repo, makeSubjects());
    await expect(service.start({ ...baseInput(), sessionUid: 'not-a-uuid' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('module / scene 不在白名单 → 1001', async () => {
    const service = new StudySessionsService(repo, makeSubjects());
    await expect(service.start({ ...baseInput(), module: 'hacked' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.start({ ...baseInput(), scene: 'hacked' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('subjectId 不属于在售学科 → 1001', async () => {
    const service = new StudySessionsService(repo, makeSubjects([1, 2, 3]));
    await expect(service.start({ ...baseInput(), subjectId: 999 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sessionUid 重复且是本人 → 幂等返回既有 startedAt，不新建', async () => {
    const existing = {
      session_uid: baseInput().sessionUid,
      student_id: 9,
      started_at: new Date('2026-09-19T09:00:00Z'),
    } as StudySessionRow;
    const r = makeRepo({ findByUid: vi.fn().mockResolvedValue(existing) });
    const service = new StudySessionsService(r, makeSubjects());

    const out = await service.start(baseInput());
    expect(out.startedAt).toEqual(existing.started_at);
    expect(r.insert).not.toHaveBeenCalled();
  });

  it('sessionUid 被别的学生占用 → 1001（不泄漏别人的会话）', async () => {
    const foreign = {
      session_uid: baseInput().sessionUid,
      student_id: 404,
      started_at: new Date(),
    } as StudySessionRow;
    const r = makeRepo({ findByUid: vi.fn().mockResolvedValue(foreign) });
    const service = new StudySessionsService(r, makeSubjects());
    await expect(service.start(baseInput())).rejects.toBeInstanceOf(BadRequestException);
    expect(r.insert).not.toHaveBeenCalled();
  });
});

describe('StudySessionsService.heartbeat', () => {
  it('命中 → 返回累计秒数', async () => {
    const repo = makeRepo({ heartbeat: vi.fn().mockResolvedValue(123) });
    const service = new StudySessionsService(repo, makeSubjects());
    await expect(
      service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'visible' }),
    ).resolves.toEqual({ activeSeconds: 123 });
  });

  it('未命中 / 非本人 / 已结束 → activeSeconds:null（静默，不抛）', async () => {
    const repo = makeRepo({ heartbeat: vi.fn().mockResolvedValue(null) });
    const service = new StudySessionsService(repo, makeSubjects());
    await expect(
      service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'visible' }),
    ).resolves.toEqual({ activeSeconds: null });
  });

  it('state 非法 → 1001（这是契约，不静默）', async () => {
    const repo = makeRepo();
    const service = new StudySessionsService(repo, makeSubjects());
    await expect(
      service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'zzz' as never }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('StudySessionsService.end', () => {
  it('命中 → 返回累计秒数与结束时刻', async () => {
    const repo = makeRepo();
    const service = new StudySessionsService(repo, makeSubjects());
    const out = await service.end({ studentId: 9, sessionUid: baseInput().sessionUid, reason: 'route_change' });
    expect(out.activeSeconds).toBe(90);
    expect(out.endedAt).toBeInstanceOf(Date);
  });

  it('已结束 → 回读现有值（幂等），不报错', async () => {
    const existing = {
      session_uid: baseInput().sessionUid,
      student_id: 9,
      active_seconds: 90,
      ended_at: new Date('2026-09-19T10:00:00Z'),
    } as StudySessionRow;
    const repo = makeRepo({ end: vi.fn().mockResolvedValue(null), findByUid: vi.fn().mockResolvedValue(existing) });
    const service = new StudySessionsService(repo, makeSubjects());
    const out = await service.end({ studentId: 9, sessionUid: baseInput().sessionUid, reason: 'pagehide' });
    expect(out.activeSeconds).toBe(90);
    expect(out.endedAt).toEqual(existing.ended_at);
  });

  it('reason 非法 → 1001', async () => {
    const service = new StudySessionsService(makeRepo(), makeSubjects());
    await expect(
      service.end({ studentId: 9, sessionUid: baseInput().sessionUid, reason: 'rage_quit' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
