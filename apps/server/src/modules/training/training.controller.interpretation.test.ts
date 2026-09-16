import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TrainingController } from './training.controller';

function makeController() {
  const service = {
    listInterpretationPassages: vi.fn().mockResolvedValue({ passages: [] }),
    startInterpretation: vi.fn().mockResolvedValue({ passages: [] }),
    judgeInterpretation: vi.fn().mockResolvedValue({
      passageId: 1, sentenceIndex: 0, allCorrect: true, terms: [], sentence: {}, fullTranslation: null,
    }),
  };
  return { controller: new TrainingController(service as never), service };
}

describe('TrainingController interpretation 端点', () => {
  it('GET interpretation/passages → 透传 service', async () => {
    const { controller, service } = makeController();
    const res = await controller.listInterpretationPassages();
    expect(service.listInterpretationPassages).toHaveBeenCalledOnce();
    expect(res).toEqual({ passages: [] });
  });

  it('POST interpretation/start：count 越界 → 400（上限是 3，不是默写的 20）', async () => {
    const { controller } = makeController();
    for (const count of [0, 4, 1.5, NaN]) {
      await expect(
        controller.startInterpretation({ semester: null, passageIds: null, count }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('POST interpretation/start：count 1-3 合法', async () => {
    const { controller, service } = makeController();
    await controller.startInterpretation({ semester: null, passageIds: null, count: 3 });
    expect(service.startInterpretation).toHaveBeenCalledWith({ semester: null, passageIds: null, count: 3 });
  });

  it('POST interpretation/start：semester 非法 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.startInterpretation({ semester: '中册', passageIds: null, count: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST interpretation/start：passageIds 含非法值 / 非数组 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.startInterpretation({ semester: null, passageIds: [0], count: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.startInterpretation({ semester: null, passageIds: [1.5], count: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.startInterpretation({ semester: null, passageIds: 'x' as never, count: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST interpretation/start：合法**非空** passageIds 原样透传（指定篇目路径）', async () => {
    const { controller, service } = makeController();
    await controller.startInterpretation({ semester: null, passageIds: [3, 5], count: 2 });
    expect(service.startInterpretation).toHaveBeenCalledWith({
      semester: null, passageIds: [3, 5], count: 2,
    });
  });

  it('POST interpretation/judge：passageId 非正整数 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.judgeInterpretation({ passageId: 0, sentenceIndex: 0, terms: [], translation: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST interpretation/judge：sentenceIndex 负数/非整数 → 400（0 是合法首句）', async () => {
    const { controller } = makeController();
    await expect(
      controller.judgeInterpretation({ passageId: 1, sentenceIndex: -1, terms: [], translation: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.judgeInterpretation({ passageId: 1, sentenceIndex: 0.5, terms: [], translation: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const { service } = makeController();
    const c2 = new TrainingController(service as never);
    await c2.judgeInterpretation({ passageId: 1, sentenceIndex: 0, terms: [], translation: '' });
    expect(service.judgeInterpretation).toHaveBeenCalled();
  });

  it('POST interpretation/judge：terms 非数组 → 透传 []（不 500）', async () => {
    const { controller, service } = makeController();
    await controller.judgeInterpretation(
      { passageId: 1, sentenceIndex: 0, terms: 'x' as never, translation: '' },
    );
    expect(service.judgeInterpretation).toHaveBeenCalledWith({
      passageId: 1, sentenceIndex: 0, terms: [], translation: '',
    });
  });

  it('POST interpretation/judge：answer 非字符串降级空串；term 非字符串的条目被丢弃', async () => {
    // 不降级的话 number 会带着进 normalizeChineseAnswer 触发 TypeError 变 500
    const { controller, service } = makeController();
    await controller.judgeInterpretation({
      passageId: 1,
      sentenceIndex: 0,
      terms: [
        { term: '谪守', answer: 123 },
        { term: 456, answer: 'x' },
        { term: '越明年', answer: null },
        null,
        'x',
      ] as never,
      translation: 789 as never,
    });
    expect(service.judgeInterpretation).toHaveBeenCalledWith({
      passageId: 1,
      sentenceIndex: 0,
      terms: [
        { term: '谪守', answer: '' },
        { term: '越明年', answer: '' },
      ],
      translation: '',
    });
  });

  it('POST interpretation/judge：合法入参原样透传（不传 studentId）', async () => {
    const { controller, service } = makeController();
    await controller.judgeInterpretation({
      passageId: 12,
      sentenceIndex: 3,
      terms: [{ term: '谪守', answer: '被贬官' }],
      translation: '庆历四年春天，滕子京被贬到巴陵郡。',
    });
    expect(service.judgeInterpretation).toHaveBeenCalledWith({
      passageId: 12,
      sentenceIndex: 3,
      terms: [{ term: '谪守', answer: '被贬官' }],
      translation: '庆历四年春天，滕子京被贬到巴陵郡。',
    });
  });
});
