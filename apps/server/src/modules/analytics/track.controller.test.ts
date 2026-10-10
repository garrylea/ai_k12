import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TrackController } from './track.controller.js';
import type { TrackEventInput } from './events.service.js';

function makeDeps() {
  const recordMany = vi.fn(async (_inputs: TrackEventInput[]) => ({ accepted: 1, rejected: 0 }));
  // study-sessions.service.ts 同款口径：findAll() + some(id)，只校验在售学科
  const subjects = { findAll: vi.fn(async () => [{ id: 5 }]) };
  const ctl = new TrackController({ recordMany } as any, subjects as any);
  return { ctl, recordMany, subjects };
}
const user = { sub: 7, role: 'student' } as any;

describe('TrackController POST /api/track/events', () => {
  afterEach(() => vi.restoreAllMocks());

  it('合法单条 → accepted 1，透传字段已补全', async () => {
    const { ctl, recordMany } = makeDeps();
    const r = await ctl.submit(user, {
      events: [{ event: 'page_view', module: 'mainline', scene: 'course_detail' }],
    });
    expect(r).toEqual({ accepted: 1, rejected: 0 });
    expect(recordMany.mock.calls[0][0][0]).toMatchObject({
      studentId: 7,
      actorRole: 'student',
      source: 'client',
    });
  });

  it('批量 > 50 → 400/1001', async () => {
    const { ctl } = makeDeps();
    const events = Array.from({ length: 51 }, () => ({ event: 'page_view' }));
    await expect(ctl.submit(user, { events })).rejects.toMatchObject({
      response: { code: 1001 },
    });
  });

  it('events 缺失/非数组 → 400/1001（parseInput 模式，不是 500）', async () => {
    const { ctl } = makeDeps();
    await expect(ctl.submit(user, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('subjectId 不在售学科 → 400/1001', async () => {
    const { ctl, subjects } = makeDeps();
    subjects.findAll.mockResolvedValueOnce([] as any);
    await expect(
      ctl.submit(user, { events: [{ event: 'page_view', subjectId: 999 }] }),
    ).rejects.toMatchObject({ response: { code: 1001 } });
  });

  it('subjectId 校验只对带 subjectId 的条目发生', async () => {
    const { ctl, subjects } = makeDeps();
    await ctl.submit(user, { events: [{ event: 'page_view' }] });
    expect(subjects.findAll).not.toHaveBeenCalled();
  });

  it('伪造服务端权威事件（answer_submitted）→ controller 原样透传给 recordMany，白名单拒伪归 EventsService', async () => {
    const { ctl, recordMany } = makeDeps();
    const r = await ctl.submit(user, {
      events: [
        { event: 'page_view' },
        { event: 'answer_submitted', refId: 3 },
      ],
    });
    // 透传：条数一致、event 原样、补全字段齐全；不 400
    const inputs = recordMany.mock.calls[0][0];
    expect(inputs).toHaveLength(2);
    expect(inputs.map((e) => e.event)).toEqual(['page_view', 'answer_submitted']);
    for (const e of inputs) {
      expect(e).toMatchObject({ studentId: 7, actorRole: 'student', source: 'client' });
    }
    // 返回值原样透传（accepted/rejected 的计数由 EventsService 决定）
    expect(r).toEqual({ accepted: 1, rejected: 0 });
  });
});
