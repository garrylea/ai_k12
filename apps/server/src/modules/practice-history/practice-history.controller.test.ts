import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PracticeHistoryController } from './practice-history.controller.js';

const USER = { sub: 7 } as never;

function make() {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    getDetail: vi.fn().mockResolvedValue(null),
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
