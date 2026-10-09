import { describe, it, expect, vi } from 'vitest';
import { TrainingController } from './training.controller';

function makeController() {
  const service = { getHint: vi.fn().mockResolvedValue({ hint: '提示' }) };
  const events = { track: vi.fn() };
  // events 是 @Optional 第 5 参：既有测试文件用 4 参构造，这里显式传第 5 参以断言埋点。
  return {
    controller: new TrainingController(service as never, {} as never, {} as never, {} as never, events as never),
    service,
    events,
  };
}

const USER = { sub: 7, role: 'student' as const };

describe('TrainingController.hint — 埋点（hint_requested）', () => {
  it('track 收到 event=hint_requested、module=null、refId=questionId；照常透传 service', async () => {
    const { controller, service, events } = makeController();
    await controller.hint({ questionId: 42 }, USER);

    expect(events.track).toHaveBeenCalledTimes(1);
    expect(events.track).toHaveBeenCalledWith(expect.objectContaining({
      event: 'hint_requested',
      source: 'server',
      studentId: 7,
      module: null,
      refType: 'question',
      refId: 42,
    }));
    expect(service.getHint).toHaveBeenCalledWith({ questionId: 42 });
  });
});
