import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { VocabularyController } from './vocabulary.controller.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';

const STUDENT = { sub: 9, role: 'student' } as JwtUser;

function makeController() {
  const service = {
    getOptions: vi.fn().mockResolvedValue({ pools: [], todayAnswered: 0, counts: {} }),
    start: vi.fn().mockResolvedValue({ questions: [], poolSize: 0 }),
    judge: vi.fn().mockResolvedValue({ verdict: 'correct' }),
    clearWrongMark: vi.fn().mockResolvedValue({ ok: true }),
    getFamily: vi.fn().mockResolvedValue({ root: {}, members: [] }),
  };
  return { controller: new VocabularyController(service as never), service };
}

/** 合法的最小开练入参，用例只覆盖自己要测的那一项。 */
const okStart = (over: Record<string, unknown> = {}) => ({
  levelPool: 'all',
  count: 10,
  order: 'random',
  letter: null,
  direction: 'en2cn',
  ...over,
});

describe('VocabularyController — 学生身份', () => {
  it('学生 id 取自 JwtUser.sub（四个需登录的端点都带上）', async () => {
    const { controller, service } = makeController();
    await controller.getOptions(STUDENT);
    await controller.start(okStart() as never, STUDENT);
    await controller.judge({ wordId: 1, senseIndex: 0, promptKind: 'en2cn', answer: 'x' }, STUDENT);
    await controller.clearProgress({ wordId: 1 }, STUDENT);
    expect(service.getOptions).toHaveBeenCalledWith(9);
    expect(service.start.mock.calls[0][1]).toBe(9);
    expect(service.judge.mock.calls[0][1]).toBe(9);
    expect(service.clearWrongMark).toHaveBeenCalledWith(1, 9);
  });
});

describe('VocabularyController — start 入参校验', () => {
  it('count 非 10-20 整数 → 400', async () => {
    const { controller } = makeController();
    for (const count of [9, 21, 0, 12.5, '10', undefined]) {
      await expect(controller.start(okStart({ count }) as never, STUDENT))
        .rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('count 边界 10 与 20 放行', async () => {
    const { controller, service } = makeController();
    await controller.start(okStart({ count: 10 }) as never, STUDENT);
    await controller.start(okStart({ count: 20 }) as never, STUDENT);
    expect(service.start).toHaveBeenCalledTimes(2);
  });

  it('三个枚举走白名单，非法值 → 400', async () => {
    const { controller } = makeController();
    await expect(controller.start(okStart({ levelPool: 'primary' }) as never, STUDENT))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.start(okStart({ order: 'shuffle' }) as never, STUDENT))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.start(okStart({ direction: 'en2en' }) as never, STUDENT))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('order=letter 必须给单个字母；多字符/通配符/数字 → 400', async () => {
    const { controller, service } = makeController();
    await controller.start(okStart({ order: 'letter', letter: 'a' }) as never, STUDENT);
    expect(service.start.mock.calls[0][0].letter).toBe('a');
    for (const letter of ['ab', '%', '_', '', '1', null]) {
      await expect(controller.start(okStart({ order: 'letter', letter }) as never, STUDENT))
        .rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('order 不是 letter 却带了字母 → 400（静默忽略会让学生以为筛选生效了）', async () => {
    const { controller } = makeController();
    await expect(controller.start(okStart({ order: 'alpha', letter: 'a' }) as never, STUDENT))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('四个筛选布尔值：只认严格 true，其它一律 false（防 "true" 字符串这类脏值）', async () => {
    const { controller, service } = makeController();
    await controller.start(
      okStart({ onlyNotLearned: true, onlyMyWrong: 'true', onlyCommonWrong: 1, onlyExtendedSense: undefined }) as never,
      STUDENT,
    );
    expect(service.start.mock.calls[0][0]).toMatchObject({
      onlyNotLearned: true,
      onlyMyWrong: false,
      onlyCommonWrong: false,
      onlyExtendedSense: false,
    });
  });
});

describe('VocabularyController — judge 入参校验', () => {
  it('wordId 非正整数 → 400', async () => {
    const { controller } = makeController();
    await expect(controller.judge({ wordId: 0, senseIndex: 0, promptKind: 'en2cn' }, STUDENT))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.judge({ wordId: 1.5, senseIndex: 0, promptKind: 'en2cn' }, STUDENT))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('senseIndex 非非负整数 → 400', async () => {
    const { controller } = makeController();
    await expect(controller.judge({ wordId: 1, senseIndex: -1, promptKind: 'en2cn' }, STUDENT))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('promptKind 非法 → 400', async () => {
    const { controller } = makeController();
    await expect(controller.judge({ wordId: 1, senseIndex: 0, promptKind: 'cn2cn' }, STUDENT))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('answer 非字符串 → 降级为空串（否则会带着 number 进归一化函数变 500）', async () => {
    const { controller, service } = makeController();
    await controller.judge({ wordId: 1, senseIndex: 0, promptKind: 'en2cn', answer: 123 as never }, STUDENT);
    expect(service.judge.mock.calls[0][0].answer).toBe('');
  });
});

describe('VocabularyController — 其它端点', () => {
  it('progress/clear：wordId 非正整数 → 400', async () => {
    const { controller } = makeController();
    await expect(controller.clearProgress({ wordId: 0 }, STUDENT)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('progress/clear 透传 wordId 与学生 id', async () => {
    const { controller, service } = makeController();
    await controller.clearProgress({ wordId: 7 }, STUDENT);
    expect(service.clearWrongMark).toHaveBeenCalledWith(7, 9);
  });

  it('words/:wordId/family 透传 wordId，不传学生 id（族数据与个人无关，可缓存）', async () => {
    const { controller, service } = makeController();
    await controller.getFamily(7);
    expect(service.getFamily).toHaveBeenCalledWith(7);
  });
});
