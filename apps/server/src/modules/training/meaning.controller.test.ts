import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { MeaningController } from './meaning.controller.js';

function makeController() {
  const service = {
    listMeaningPassages: vi.fn().mockResolvedValue({ passages: [] }),
    startMeaning: vi.fn().mockResolvedValue({ passages: [] }),
    judgeMeaning: vi.fn().mockResolvedValue({ allCorrect: true }),
  };
  return { controller: new MeaningController(service as never), service };
}

describe('MeaningController.start', () => {
  it('count 越界 → 400', async () => {
    const { controller } = makeController();
    await expect(controller.startMeaning({ semester: null, passageIds: null, count: 4 }))
      .rejects.toThrow(BadRequestException);
    await expect(controller.startMeaning({ semester: null, passageIds: null, count: 0 }))
      .rejects.toThrow(BadRequestException);
  });

  it('semester 非法 → 400', async () => {
    const { controller } = makeController();
    await expect(controller.startMeaning({ semester: '中部', passageIds: null, count: 1 }))
      .rejects.toThrow(BadRequestException);
  });

  it('passageIds 非正整数 → 400', async () => {
    const { controller } = makeController();
    await expect(controller.startMeaning({ semester: null, passageIds: [0], count: 1 }))
      .rejects.toThrow(BadRequestException);
  });

  it('合法入参透传给 service', async () => {
    const { controller, service } = makeController();
    await controller.startMeaning({ semester: '上册', passageIds: [3], count: 2 });
    expect(service.startMeaning).toHaveBeenCalledWith({ semester: '上册', passageIds: [3], count: 2 });
  });
});

describe('MeaningController.judge', () => {
  it('非法入参 → 400', async () => {
    const { controller } = makeController();
    await expect(controller.judgeMeaning({ passageId: 0, sentenceIndex: 0, terms: [], meaning: '', emotion: '' }))
      .rejects.toThrow(BadRequestException);
    await expect(controller.judgeMeaning({ passageId: 1, sentenceIndex: -1, terms: [], meaning: '', emotion: '' }))
      .rejects.toThrow(BadRequestException);
  });

  it('脏入参静默规范化，不 500', async () => {
    const { controller, service } = makeController();
    await controller.judgeMeaning({
      passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉舟', answer: 123 as never }, null as never, { term: 5 as never, answer: 'x' }],
      meaning: 42 as never, emotion: null as never,
    });
    expect(service.judgeMeaning).toHaveBeenCalledWith({
      passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉舟', answer: '' }],
      meaning: '', emotion: '',
    });
  });
});
