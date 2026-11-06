import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PracticeHistoryController } from './practice-history.controller.js';

const USER = { sub: 7 } as never;

function make() {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    getDetail: vi.fn().mockResolvedValue(null),
    redo: vi.fn().mockResolvedValue(null),
    similar: vi.fn().mockResolvedValue(null),
  };
  return { controller: new PracticeHistoryController(service as never), service };
}

describe('PracticeHistoryController.list', () => {
  it('把 query 字符串转 number 后交给 service，studentId 只取 JWT', async () => {
    const { controller, service } = make();
    await controller.list('2', '10', '4', USER);
    expect(service.list).toHaveBeenCalledWith({
      studentId: 7, page: 2, pageSize: 10, subjectId: 4,
    });
  });

  it('query 缺失时传 undefined（让 service 走默认值）', async () => {
    const { controller, service } = make();
    await controller.list(undefined, undefined, undefined, USER);
    expect(service.list).toHaveBeenCalledWith({
      studentId: 7, page: undefined, pageSize: undefined, subjectId: undefined,
    });
  });

  it('非法数字静默回 undefined（不 400）', async () => {
    const { controller, service } = make();
    await controller.list('abc', 'xyz', 'q', USER);
    expect(service.list).toHaveBeenCalledWith({
      studentId: 7, page: undefined, pageSize: undefined, subjectId: undefined,
    });
  });
});

describe('PracticeHistoryController.detail', () => {
  it('source 非法 → 404（不泄露端点存在性）', async () => {
    const { controller } = make();
    await expect(controller.detail('xxx', 1, USER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('service 返回 null（非本人/不存在）→ 404', async () => {
    const { controller, service } = make();
    service.getDetail.mockResolvedValue(null);
    await expect(controller.detail('exam', 999, USER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('正常详情原样返回', async () => {
    const { controller, service } = make();
    const detail = { session: { source: 'exam' }, questions: [] };
    service.getDetail.mockResolvedValue(detail);
    await expect(controller.detail('exam', 1, USER)).resolves.toBe(detail);
    expect(service.getDetail).toHaveBeenCalledWith({ studentId: 7, source: 'exam', sessionId: 1 });
  });
});

describe('PracticeHistoryController.redo', () => {
  it('source 非法 → 404，且不调 service', async () => {
    const { controller, service } = make();
    await expect(controller.redo('xxx', 1, 100, USER)).rejects.toBeInstanceOf(NotFoundException);
    expect(service.redo).not.toHaveBeenCalled();
  });

  it('service 返回 null（非本人/题目不在会话）→ 404', async () => {
    const { controller } = make();
    await expect(controller.redo('exam', 1, 100, USER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('正常重做原样返回，studentId 只取 JWT', async () => {
    const { controller, service } = make();
    const res = {
      questions: [{ questionId: 100, text: '题干', type: 'choice', options: null, materialText: null }],
      title: '重做：期中卷 · 第 3 题',
    };
    service.redo.mockResolvedValue(res);
    await expect(controller.redo('exam', 1, 100, USER)).resolves.toBe(res);
    expect(service.redo).toHaveBeenCalledWith({ studentId: 7, source: 'exam', sessionId: 1, questionId: 100 });
  });
});

describe('PracticeHistoryController.similar', () => {
  it('source 非法 → 404，且不调 service', async () => {
    const { controller, service } = make();
    await expect(controller.similar('xxx', 1, 100, { count: 3 }, USER))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(service.similar).not.toHaveBeenCalled();
  });

  it('service 返回 null（非本人/题目不在会话）→ 404', async () => {
    const { controller } = make();
    await expect(controller.similar('special', 5, 100, { count: 3 }, USER))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('正常返回；count 转 number，studentId 只取 JWT', async () => {
    const { controller, service } = make();
    const res = { questions: [], sessionId: null, title: '同类练习：X · 0 题' };
    service.similar.mockResolvedValue(res);
    await expect(controller.similar('special', 5, 100, { count: 3 }, USER)).resolves.toBe(res);
    expect(service.similar).toHaveBeenCalledWith({
      studentId: 7, source: 'special', sessionId: 5, questionId: 100, count: 3,
    });
  });

  it('count 缺失 -> 交给 service 的 NaN（由 service 判 400）', async () => {
    const { controller, service } = make();
    service.similar.mockResolvedValue({ questions: [], sessionId: null, title: 't' });
    await controller.similar('exam', 1, 100, {}, USER);
    expect(service.similar).toHaveBeenCalledWith(
      expect.objectContaining({ count: Number.NaN }),
    );
  });
});
