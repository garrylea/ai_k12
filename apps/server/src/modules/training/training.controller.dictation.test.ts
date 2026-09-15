import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TrainingController } from './training.controller';

function makeController() {
  const service = {
    listDictationPassages: vi.fn().mockResolvedValue({ passages: [] }),
    startDictation: vi.fn().mockResolvedValue({ questions: [] }),
    judgeDictation: vi.fn().mockResolvedValue({ isCorrect: true, feedback: null }),
    generateDictationFeedback: vi.fn().mockResolvedValue({ feedback: null }),
  };
  return { controller: new TrainingController(service as never), service };
}

describe('TrainingController dictation 端点', () => {
  it('GET dictation/passages → 透传 service', async () => {
    const { controller, service } = makeController();
    const res = await controller.listDictationPassages();
    expect(service.listDictationPassages).toHaveBeenCalledOnce();
    expect(res).toEqual({ passages: [] });
  });

  it('POST dictation/start：count 越界 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.startDictation({ semester: null, passageIds: null, count: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.startDictation({ semester: null, passageIds: null, count: 21 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/start：semester 非法 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.startDictation({ semester: '上学期', passageIds: null, count: 5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/start：passageIds 含非法值 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.startDictation({ semester: null, passageIds: [0], count: 5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/start：合法入参 → 透传 semester/passageIds/count（不再传 studentId）', async () => {
    // 独立化后「不再展示」join 已移除，studentId 不再参与抽题——传了就是死参数
    const { controller, service } = makeController();
    await controller.startDictation({ semester: '上册', passageIds: null, count: 5 });
    expect(service.startDictation).toHaveBeenCalledWith({
      semester: '上册', passageIds: null, count: 5,
    });
  });

  it('POST dictation/judge：passageId 非正整数 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.judgeDictation({ passageId: 0, author: '', dynasty: '', body: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/judge：缺字段按空串处理并透传（不传 studentId）', async () => {
    const { controller, service } = makeController();
    await controller.judgeDictation({ passageId: 1 } as never);
    expect(service.judgeDictation).toHaveBeenCalledWith({
      passageId: 1, author: '', dynasty: '', body: '',
    });
  });

  it('POST dictation/judge：非字符串字段降级为空串（不把 number 透传给 service）', async () => {
    const { controller, service } = makeController();
    await controller.judgeDictation(
      { passageId: 1, author: 123, dynasty: null, body: {} } as never,
    );
    expect(service.judgeDictation).toHaveBeenCalledWith({
      passageId: 1, author: '', dynasty: '', body: '',
    });
  });

  it('POST dictation/feedback：passageId 非正整数 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.generateDictationFeedback({ passageId: -1, author: '', dynasty: '', body: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/feedback：合法入参 → 透传三字段', async () => {
    const { controller, service } = makeController();
    await controller.generateDictationFeedback({
      passageId: 1, author: '李白', dynasty: '唐', body: '床前明月先',
    });
    expect(service.generateDictationFeedback).toHaveBeenCalledWith({
      passageId: 1, author: '李白', dynasty: '唐', body: '床前明月先',
    });
  });

  it('POST dictation/feedback：非字符串字段同样降级为空串', async () => {
    const { controller, service } = makeController();
    await controller.generateDictationFeedback(
      { passageId: 1, author: 123, dynasty: null, body: {} } as never,
    );
    expect(service.generateDictationFeedback).toHaveBeenCalledWith({
      passageId: 1, author: '', dynasty: '', body: '',
    });
  });
});
