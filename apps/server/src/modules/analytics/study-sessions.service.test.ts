import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, Logger } from '@nestjs/common';
import { StudySessionsService } from './study-sessions.service.js';
import type { StudySessionsRepository, StudySessionRow } from '../../database/repositories/study-sessions.repo.js';
import type { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import type { ControlsRepository } from '../../database/repositories/controls.repo.js';
import type { SafetyAlertsService } from '../safety/safety-alerts.service.js';

const MAC_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const UID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/** 心跳未命中挂机段时的默认返回（`hiddenSince` / `hiddenReason` 都是 null）。 */
const noHidden = (activeSeconds: number) => ({ activeSeconds, hiddenSince: null, hiddenReason: null });

function makeRepo(overrides: Partial<StudySessionsRepository> = {}) {
  return {
    findByUid: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(true),
    heartbeat: vi.fn().mockResolvedValue(noHidden(60)),
    end: vi.fn().mockResolvedValue({
      activeSeconds: 90,
      endedAt: new Date('2026-09-19T10:00:00Z'),
      hiddenSince: null,
      hiddenReason: null,
    }),
    closeStale: vi.fn().mockResolvedValue({ closedCount: 0, hidden: [] }),
    ...overrides,
  } as unknown as StudySessionsRepository;
}

function makeSubjects(ids: number[] = [1, 2, 3]) {
  return { findAll: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))) } as unknown as SubjectsRepository;
}

/** 预警写入口的假实现：文案带上 type 与 minutes，便于断言「传进去的分钟数对不对」。 */
function makeSafety(overrides: Partial<SafetyAlertsService> = {}) {
  return {
    record: vi.fn(),
    messageFor: vi.fn((type: string, minutes?: number) => `msg:${type}:${minutes ?? 0}`),
    awayContext: vi.fn((type: string, minutes: number) => `ctx:${type}:${minutes}`),
    ...overrides,
  } as unknown as SafetyAlertsService;
}

function makeControls(overrides: Partial<ControlsRepository> = {}) {
  return {
    findAlertThresholds: vi.fn().mockResolvedValue({ awayMinutes: 5, idleMinutes: 15 }),
    ...overrides,
  } as unknown as ControlsRepository;
}

/** 缺省阈值 5 / 15，缺省 `record` 是 no-op。 */
function makeService(
  repo: StudySessionsRepository,
  subjects = makeSubjects(),
  safety = makeSafety(),
  controls = makeControls(),
) {
  return new StudySessionsService(repo, subjects, safety, controls);
}

const baseInput = () => ({
  studentId: 9,
  sessionUid: UID,
  module: 'training_targeted',
  scene: 'targeted_run',
  userAgent: MAC_CHROME_UA,
});

/**
 * 让出一个宏任务：微任务队列先排空，`void` 出去的判定链（最多一次 `await`）此刻已跑完。
 *
 * 用于**否定断言**（「没写预警」）：判定是 `void` 出去的，紧跟心跳的同步断言会在判定
 * 跑完之前执行 → 恒真。但也不能只等 `vi.waitFor(findAlertThresholds 被调用)`——那只
 * 证明「查询发出去了」，不保证它的续体（真正决定写不写的那段）已经跑过。
 */
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 在 `fn` 执行期间捕获**逃逸的 unhandled rejection**（返回捕获到的原因列表）。
 *
 * 为什么需要：心跳/结束改成 `void this.maybeRecordHiddenAlert(...)` 之后，「失败不会让
 * 请求 500」由构造保证、不再是被测行为；`void` 引入的**新**风险是「该 promise 若 reject
 * 则无人接管」。这条风险只能从 run 级观测到，不能在调用点断言。
 *
 * `unhandledRejection` 在微任务队列排空后的同一轮事件循环里派发，所以 `setTimeout(0)`
 * 足以确保已派发（本机 Node 实测：一次 `setTimeout(0)` 后即捕获到，见报告）。
 */
async function withUnhandledRejectionSpy(fn: () => Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    await flushAsync();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return rejections;
}

describe('StudySessionsService.start', () => {
  let repo: StudySessionsRepository;

  beforeEach(() => {
    repo = makeRepo();
  });

  it('新建：解析 UA + 落库，返回 startedAt', async () => {
    const service = makeService(repo);
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
    const service = makeService(repo);
    await service.start({ ...baseInput(), inputType: 'touch' });
    expect((repo.insert as any).mock.calls[0][0].platformClass).toBe('ipad');
  });

  it('Macintosh UA + input_type=mouse → 仍是 mac（不误判）', async () => {
    const service = makeService(repo);
    await service.start({ ...baseInput(), inputType: 'mouse' });
    expect((repo.insert as any).mock.calls[0][0].platformClass).toBe('mac');
  });

  it('设备字段非法 → 存 NULL，不报错（设备信息是尽力而为）', async () => {
    const service = makeService(repo);
    await service.start({ ...baseInput(), screenClass: 'nintendo-switch', inputType: 'wand', appShell: 'wechat' });
    const arg = (repo.insert as any).mock.calls[0][0];
    expect(arg.screenClass).toBeNull();
    expect(arg.inputType).toBeNull();
    expect(arg.appShell).toBeNull();
  });

  it('sessionUid 非 UUID → 1001', async () => {
    const service = makeService(repo);
    await expect(service.start({ ...baseInput(), sessionUid: 'not-a-uuid' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('module / scene 不在白名单 → 1001', async () => {
    const service = makeService(repo);
    await expect(service.start({ ...baseInput(), module: 'hacked' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.start({ ...baseInput(), scene: 'hacked' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('subjectId 不属于在售学科 → 1001', async () => {
    const service = makeService(repo, makeSubjects([1, 2, 3]));
    await expect(service.start({ ...baseInput(), subjectId: 999 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sessionUid 重复且是本人 → 幂等返回既有 startedAt，不新建', async () => {
    const existing = {
      session_uid: baseInput().sessionUid,
      student_id: 9,
      started_at: new Date('2026-09-19T09:00:00Z'),
    } as StudySessionRow;
    const r = makeRepo({ findByUid: vi.fn().mockResolvedValue(existing) });
    const service = makeService(r);

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
    const service = makeService(r);
    await expect(service.start(baseInput())).rejects.toBeInstanceOf(BadRequestException);
    expect(r.insert).not.toHaveBeenCalled();
  });
});

describe('StudySessionsService.heartbeat', () => {
  it('命中 → 返回累计秒数', async () => {
    const repo = makeRepo({ heartbeat: vi.fn().mockResolvedValue(noHidden(123)) });
    const service = makeService(repo);
    await expect(
      service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'visible' }),
    ).resolves.toEqual({ activeSeconds: 123 });
  });

  it('未命中 / 非本人 / 已结束 → activeSeconds:null（静默，不抛）', async () => {
    const repo = makeRepo({ heartbeat: vi.fn().mockResolvedValue(null) });
    const service = makeService(repo);
    await expect(
      service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'visible' }),
    ).resolves.toEqual({ activeSeconds: null });
  });

  it('state 非法 → 1001（这是契约，不静默）', async () => {
    const repo = makeRepo();
    const service = makeService(repo);
    await expect(
      service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'zzz' as never }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reason 逐位透传给仓储（第 5 个参数），非法/缺失归一为 null', async () => {
    const repo = makeRepo();
    const service = makeService(repo);

    await service.heartbeat({
      studentId: 9,
      sessionUid: baseInput().sessionUid,
      state: 'hidden',
      subjectId: 2,
      reason: 'away',
    });
    expect((repo.heartbeat as any).mock.calls[0]).toEqual([baseInput().sessionUid, 9, 'hidden', 2, 'away']);

    // 旧客户端不带 reason / 带了非法值 → 一律 null（=「没带」），不 400
    await service.heartbeat({
      studentId: 9,
      sessionUid: baseInput().sessionUid,
      state: 'hidden',
      reason: 'hacked',
    });
    expect((repo.heartbeat as any).mock.calls[1][4]).toBeNull();

    await service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'hidden' });
    expect((repo.heartbeat as any).mock.calls[2][4]).toBeNull();
  });

  it('挂机达到阈值 → 写 away 预警（level=info，文案与分钟数走 SafetyAlertsService）', async () => {
    const since = new Date(Date.now() - 6 * 60_000); // 本段已连续 6 分钟
    const repo = makeRepo({
      heartbeat: vi.fn().mockResolvedValue({ activeSeconds: 300, hiddenSince: since, hiddenReason: 'away' }),
    });
    const safety = makeSafety();
    const controls = makeControls();
    const service = makeService(repo, makeSubjects(), safety, controls);

    await expect(
      service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'hidden', reason: 'away' }),
    ).resolves.toEqual({ activeSeconds: 300 });

    // 判定是 `void` 出去的（心跳路径不得 await 它）→ 必须**异步等待**写入发生。
    // 同步 `toHaveBeenCalled()` 会跑在写入之前，变成不稳定/恒假。
    await vi.waitFor(() => expect(safety.record).toHaveBeenCalledTimes(1));
    expect(controls.findAlertThresholds).toHaveBeenCalledWith(9);
    expect(safety.record).toHaveBeenCalledWith({
      studentId: 9,
      dialogueId: null,
      type: 'away',
      level: 'info',
      message: 'msg:away:6',
      context: 'ctx:away:6',
    });
  });

  it('idle 段达到 idle 阈值 → 写 idle 预警', async () => {
    const since = new Date(Date.now() - 16 * 60_000); // 16 分钟 > 默认 idle 15 分钟
    const repo = makeRepo({
      heartbeat: vi.fn().mockResolvedValue({ activeSeconds: 300, hiddenSince: since, hiddenReason: 'idle' }),
    });
    const safety = makeSafety();
    const service = makeService(repo, makeSubjects(), safety, makeControls());

    await service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'hidden', reason: 'idle' });

    await vi.waitFor(() =>
      expect(safety.record).toHaveBeenCalledWith(expect.objectContaining({ type: 'idle', level: 'info' })),
    );
  });

  it('未达阈值 → 不写预警（away 4 分钟 < 默认 5 分钟）', async () => {
    const since = new Date(Date.now() - 4 * 60_000);
    const repo = makeRepo({
      heartbeat: vi.fn().mockResolvedValue({ activeSeconds: 240, hiddenSince: since, hiddenReason: 'away' }),
    });
    const safety = makeSafety();
    const controls = makeControls();
    const service = makeService(repo, makeSubjects(), safety, controls);

    await service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'hidden', reason: 'away' });

    // 先让判定链跑完（`void` 出去的那段），否则「没写」可能只是「还没轮到」→ 恒真。
    // 再断言查询真的发生过：证明判定跑到了比较那一步，而不是整条路径被跳过。
    await flushAsync();
    expect(controls.findAlertThresholds).toHaveBeenCalledWith(9);
    expect(safety.record).not.toHaveBeenCalled();
  });

  it('家长设定的阈值真的生效：同一段 3 分钟，阈值 5 不报、阈值 2 就报', async () => {
    const since = new Date(Date.now() - 3 * 60_000);
    const repo = makeRepo({
      heartbeat: vi.fn().mockResolvedValue({ activeSeconds: 180, hiddenSince: since, hiddenReason: 'away' }),
    });
    const input = { studentId: 9, sessionUid: baseInput().sessionUid, state: 'hidden', reason: 'away' };

    const strictControls = makeControls();
    const strictSafety = makeSafety();
    await makeService(repo, makeSubjects(), strictSafety, strictControls).heartbeat(input);
    await flushAsync();
    expect(strictControls.findAlertThresholds).toHaveBeenCalledWith(9); // 判定确实跑了
    expect(strictSafety.record).not.toHaveBeenCalled(); // 默认 5 分钟

    const looseSafety = makeSafety();
    const looseControls = makeControls({
      findAlertThresholds: vi.fn().mockResolvedValue({ awayMinutes: 2, idleMinutes: 15 }),
    });
    await makeService(repo, makeSubjects(), looseSafety, looseControls).heartbeat(input);
    // 家长改成 2 分钟 → 3 分钟就报（`void` 出去，故异步等待）
    await vi.waitFor(() => expect(looseSafety.record).toHaveBeenCalledTimes(1));
  });

  it('心跳响应不等待阈值判定（`void`）：判定被挂住时心跳仍立刻返回，放行后才写预警', async () => {
    // 这条直接钉「心跳路径绝不拖长响应」这条硬约束：让 `findAlertThresholds` 返回一个
    // **永不自动 settle** 的 promise（模拟 DB 慢查询）。若实现改回 `await`，下面那次
    // `await service.heartbeat(...)` 会一直挂着 → 用例超时必红。
    const since = new Date(Date.now() - 6 * 60_000);
    const repo = makeRepo({
      heartbeat: vi.fn().mockResolvedValue({ activeSeconds: 300, hiddenSince: since, hiddenReason: 'away' }),
    });
    let release!: (t: { awayMinutes: number; idleMinutes: number }) => void;
    const controls = makeControls({
      findAlertThresholds: vi.fn(
        () =>
          new Promise<{ awayMinutes: number; idleMinutes: number }>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const safety = makeSafety();
    const service = makeService(repo, makeSubjects(), safety, controls);

    await expect(
      service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'hidden', reason: 'away' }),
    ).resolves.toEqual({ activeSeconds: 300 });

    // 心跳已返回时判定还挂在那里 → 证明它确实没被 await
    await flushAsync();
    expect(safety.record).not.toHaveBeenCalled();

    // 放行后 fire-and-forget 的那段仍然会完成写入（`void` 不是「丢掉不写」）
    release({ awayMinutes: 5, idleMinutes: 15 });
    await vi.waitFor(() => expect(safety.record).toHaveBeenCalledTimes(1));
  });

  it('visible 心跳（hidden_reason 为 null）→ 不查阈值、不写预警', async () => {
    const repo = makeRepo({ heartbeat: vi.fn().mockResolvedValue(noHidden(120)) });
    const safety = makeSafety();
    const controls = makeControls();
    const service = makeService(repo, makeSubjects(), safety, controls);

    await service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'visible' });

    await flushAsync();
    // 这里的否定断言是确定性的：`hiddenReason !== 'away' && !== 'idle'` 的早退发生在
    // `maybeRecordHiddenAlert` 的第一个 `await` **之前**（async 函数体同步执行到首个 await），
    // 所以查询一次都不会发出——与 `void` 无关，也与调度时序无关。
    expect(controls.findAlertThresholds).not.toHaveBeenCalled();
    expect(safety.record).not.toHaveBeenCalled();
  });

  it('预警写入抛错 → 不 reject、被 warn 吞掉、心跳仍正常返回（`void` 不产生 unhandled rejection）', async () => {
    const since = new Date(Date.now() - 6 * 60_000);
    const repo = makeRepo({
      heartbeat: vi.fn().mockResolvedValue({ activeSeconds: 300, hiddenSince: since, hiddenReason: 'away' }),
    });
    const safety = makeSafety({
      record: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = makeService(repo, makeSubjects(), safety, makeControls());

    try {
      // `void` 之后「心跳仍返回 200」由构造保证、不再是被测行为；这条用例改测三件真正
      // 还在被测的事：① 心跳响应本身正常；② 失败被 logger.warn 吞掉（catch 真的走到了）；
      // ③ `void` 出去的那个 promise 没有逃逸成 unhandled rejection（`void` 的新风险）。
      const rejections = await withUnhandledRejectionSpy(async () => {
        await expect(
          service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'hidden', reason: 'away' }),
        ).resolves.toEqual({ activeSeconds: 300 });

        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('走神预警判定失败')),
        );
      });

      expect(safety.record).toHaveBeenCalledTimes(1); // 真的走到了写入并抛出
      expect(rejections).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('阈值查询抛错 → 不 reject、被 warn 吞掉、心跳仍正常返回（失败只 warn，不 500）', async () => {
    const since = new Date(Date.now() - 6 * 60_000);
    const repo = makeRepo({
      heartbeat: vi.fn().mockResolvedValue({ activeSeconds: 300, hiddenSince: since, hiddenReason: 'away' }),
    });
    const controls = makeControls({
      findAlertThresholds: vi.fn().mockRejectedValue(new Error('db down')),
    });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = makeService(repo, makeSubjects(), makeSafety(), controls);

    try {
      const rejections = await withUnhandledRejectionSpy(async () => {
        await expect(
          service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'hidden', reason: 'away' }),
        ).resolves.toEqual({ activeSeconds: 300 });

        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('走神预警判定失败')),
        );
      });
      expect(rejections).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('state=visible 却带了 reason → 归一为 null 再落库（hidden_reason 列不变量）', async () => {
    // `study_sessions.hidden_reason` 的语义是「当前连续挂机段的原因；回到 visible 时置 NULL」。
    // 手搓 `{"state":"visible","reason":"away"}`（Zod 合法）若不归一，会落成
    // `client_state='visible'` + `hidden_reason='away'` 的坏组合。归一在 service 侧做，
    // repo 是薄 SQL 层、不做归一。
    const repo = makeRepo();
    const service = makeService(repo);

    await service.heartbeat({
      studentId: 9,
      sessionUid: baseInput().sessionUid,
      state: 'visible',
      reason: 'away',
    });

    expect((repo.heartbeat as any).mock.calls[0]).toEqual([baseInput().sessionUid, 9, 'visible', null, null]);
  });
});

describe('StudySessionsService.end', () => {
  it('命中 → 返回累计秒数与结束时刻', async () => {
    const repo = makeRepo();
    const service = makeService(repo);
    const out = await service.end({ studentId: 9, sessionUid: baseInput().sessionUid, reason: 'route_change' });
    expect(out.activeSeconds).toBe(90);
    expect(out.endedAt).toBeInstanceOf(Date);
  });

  it('结束路径也判阈值：最小化后直接关页面（pagehide → end，之后不再有心跳）也能报', async () => {
    const since = new Date(Date.now() - 8 * 60_000);
    const repo = makeRepo({
      end: vi.fn().mockResolvedValue({
        activeSeconds: 90,
        endedAt: new Date('2026-09-20T10:00:00Z'),
        hiddenSince: since,
        hiddenReason: 'away',
      }),
    });
    const safety = makeSafety();
    const controls = makeControls();
    const service = makeService(repo, makeSubjects(), safety, controls);

    const out = await service.end({ studentId: 9, sessionUid: baseInput().sessionUid, reason: 'pagehide' });

    expect(out.activeSeconds).toBe(90);
    // 结束路径的判定同样是 `void` 出去的 → 异步等待
    await vi.waitFor(() => expect(safety.record).toHaveBeenCalledTimes(1));
    expect(controls.findAlertThresholds).toHaveBeenCalledWith(9);
    expect(safety.record).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: 9, type: 'away', level: 'info', message: 'msg:away:8' }),
    );
  });

  it('结束路径未达阈值 → 不写预警', async () => {
    const since = new Date(Date.now() - 60_000);
    const repo = makeRepo({
      end: vi.fn().mockResolvedValue({
        activeSeconds: 90,
        endedAt: new Date('2026-09-20T10:00:00Z'),
        hiddenSince: since,
        hiddenReason: 'idle',
      }),
    });
    const safety = makeSafety();
    const controls = makeControls();
    const service = makeService(repo, makeSubjects(), safety, controls);

    await service.end({ studentId: 9, sessionUid: baseInput().sessionUid, reason: 'route_change' });

    await flushAsync();
    expect(controls.findAlertThresholds).toHaveBeenCalledWith(9); // 判定确实跑了，不是路径被跳过
    expect(safety.record).not.toHaveBeenCalled();
  });

  it('已结束 → 回读现有值（幂等），不报错', async () => {
    const existing = {
      session_uid: baseInput().sessionUid,
      student_id: 9,
      active_seconds: 90,
      ended_at: new Date('2026-09-19T10:00:00Z'),
    } as StudySessionRow;
    const repo = makeRepo({ end: vi.fn().mockResolvedValue(null), findByUid: vi.fn().mockResolvedValue(existing) });
    const service = makeService(repo);
    const out = await service.end({ studentId: 9, sessionUid: baseInput().sessionUid, reason: 'pagehide' });
    expect(out.activeSeconds).toBe(90);
    expect(out.endedAt).toEqual(existing.ended_at);
  });

  it('reason 非法 → 1001', async () => {
    const service = makeService(makeRepo());
    await expect(
      service.end({ studentId: 9, sessionUid: baseInput().sessionUid, reason: 'rage_quit' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
