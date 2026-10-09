import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventsService, EVENT_TIER, CLIENT_ALLOWED_EVENTS } from './events.service.js';

function makeDeps() {
  const insertMany = vi.fn(async () => undefined);
  const svc = new EventsService({ insertMany } as any);
  return { svc, insertMany };
}

describe('EventsService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('EVENT_TIER 字典 = 17 项，且 5 个 ops 难堪信号在册', () => {
    expect(Object.keys(EVENT_TIER)).toHaveLength(17);
    for (const e of ['hint_requested', 'answer_revealed', 'self_assess_answered', 'consecutive_failures', 'study_session_idle']) {
      expect((EVENT_TIER as any)[e]).toBe('ops');
    }
    expect(EVENT_TIER['answer_submitted']).toBe('parent');
  });

  it('CLIENT_ALLOWED_EVENTS 恰为 7 项（session 2 + 显式 5）', () => {
    expect([...CLIENT_ALLOWED_EVENTS].sort()).toEqual([
      'ai_message_sent', 'answer_revealed', 'card_flipped', 'page_view',
      'study_session_ended', 'study_session_idle', 'study_session_started',
    ].sort());
  });

  it('track：tier 由字典决定，调用方传 tier 无效', () => {
    const { svc, insertMany } = makeDeps();
    svc.track({ event: 'answer_submitted', source: 'server', studentId: 7 } as any);
    expect((insertMany as any).mock.calls[0][0][0]).toMatchObject({ tier: 'parent' });
  });

  it('track：未登记事件拒写', () => {
    const { svc, insertMany } = makeDeps();
    svc.track({ event: 'not_in_dict', source: 'server' } as any);
    expect(insertMany).not.toHaveBeenCalled();
  });

  it('track：repo 抛错只 warn 不冒泡', async () => {
    const { svc, insertMany } = makeDeps();
    insertMany.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => svc.track({ event: 'points_awarded', source: 'server', studentId: 1 })).not.toThrow();
    await Promise.resolve(); // track 是 fire-and-forget，warn 落在微任务里
    expect(warn).toHaveBeenCalled();
  });

  it('recordMany：校验失败计 rejected 不整体失败', async () => {
    const { svc, insertMany } = makeDeps();
    await expect(svc.recordMany([
      { event: 'page_view', source: 'client', studentId: 7 } as any,
      { event: 'answer_submitted', source: 'client', studentId: 7 } as any, // 服务端权威事件，client 白名单外
      { event: 'nope', source: 'client', studentId: 7 } as any,             // 字典外
    ])).resolves.toEqual({ accepted: 1, rejected: 2 });
    expect((insertMany as any).mock.calls[0][0]).toHaveLength(1);
    expect((insertMany as any).mock.calls[0][0][0]).toMatchObject({ event: 'page_view', tier: 'ops' });
  });

  it('recordMany：DB 失败向上抛（controller 转 500）', async () => {
    const { svc, insertMany } = makeDeps();
    insertMany.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.recordMany([{ event: 'page_view', source: 'client', studentId: 7 } as any])).rejects.toThrow();
  });
});
