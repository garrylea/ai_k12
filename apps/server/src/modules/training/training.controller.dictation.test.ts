import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TrainingController } from './training.controller';

function makeController() {
  const service = {
    listDictationPassages: vi.fn().mockResolvedValue({ passages: [] }),
    startDictation: vi.fn().mockResolvedValue({ questions: [] }),
    judgeDictation: vi.fn().mockResolvedValue({ isCorrect: true, feedback: null }),
  };
  return { controller: new TrainingController(service as never), service };
}

const USER = { sub: 7, role: 'student' } as never;

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
      controller.startDictation({ semester: null, questionIds: null, count: 0 }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.startDictation({ semester: null, questionIds: null, count: 21 }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/start：semester 非法 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.startDictation({ semester: '上学期', questionIds: null, count: 5 }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/start：questionIds 含非法值 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.startDictation({ semester: null, questionIds: [0], count: 5 }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/start：合法入参 → 透传 studentId', async () => {
    const { controller, service } = makeController();
    await controller.startDictation({ semester: '上册', questionIds: null, count: 5 }, USER);
    expect(service.startDictation).toHaveBeenCalledWith({
      studentId: 7, semester: '上册', questionIds: null, count: 5,
    });
  });

  it('POST dictation/judge：questionId 非正整数 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.judgeDictation({ questionId: 0, author: '', dynasty: '', body: '' }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/judge：缺字段按空串处理并透传 studentId', async () => {
    const { controller, service } = makeController();
    await controller.judgeDictation({ questionId: 100 } as never, USER);
    expect(service.judgeDictation).toHaveBeenCalledWith({
      studentId: 7, questionId: 100, author: '', dynasty: '', body: '',
    });
  });
});
