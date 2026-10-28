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

describe('TrainingController.hint — 埋点（hint_requested）', () => {  it('track 收到 event=hint_requested、module=null、refId=questionId；照常透传 service', async () => {
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

describe('TrainingController.startTargetedPractice — 学科任务码（cn_targeted / math_targeted）', () => {
  function makeTargetedController(allowed: string[]) {
    const service = { startTargetedPractice: vi.fn().mockResolvedValue({ questions: [], sessionId: null }) };
    const pointRulesService = { listTierKeys: vi.fn().mockResolvedValue(allowed) };
    const controller = new TrainingController(
      service as never, {} as never, {} as never, pointRulesService as never,
    );
    return { controller, service, pointRulesService };
  }

  it('语文（subjectId=2）按 cn_targeted 校验档位，service 收到原学科', async () => {
    const { controller, service, pointRulesService } = makeTargetedController(['1', '3', '5', '10']);
    await controller.startTargetedPractice({ subjectId: 2, kpId: 112, type: null, count: 5 }, USER);

    expect(pointRulesService.listTierKeys).toHaveBeenCalledWith(7, 'cn_targeted');
    expect(service.startTargetedPractice).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 2, count: 5 }));
  });

  it('数学（subjectId=1）仍按 math_targeted；档位越界 400', async () => {
    const { controller, pointRulesService } = makeTargetedController(['1', '3', '5', '10']);
    await expect(
      controller.startTargetedPractice({ subjectId: 1, kpId: 3, type: null, count: 7 }, USER),
    ).rejects.toThrow('题量仅允许');
    expect(pointRulesService.listTierKeys).toHaveBeenCalledWith(7, 'math_targeted');
  });
});
