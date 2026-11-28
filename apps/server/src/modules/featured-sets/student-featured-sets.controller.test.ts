import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA, PATH_METADATA, METHOD_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { StudentFeaturedSetsController } from './student-featured-sets.controller.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { ROLES_KEY } from '../../common/decorators/roles.js';

const GUARDS_METADATA = '__guards__';

describe('StudentFeaturedSetsController', () => {
  it('学生推荐：POST 201 且只从 JWT 取 studentId', async () => {
    const service = { recommend: vi.fn().mockResolvedValue({ setId: 3, alreadyRecommended: false }) };
    const controller = new StudentFeaturedSetsController(service as never, service as never);

    await expect(controller.recommend({ questionIds: [1, 2] }, { sub: 7 } as never))
      .resolves.toEqual({ setId: 3, alreadyRecommended: false });
    expect(service.recommend).toHaveBeenCalledWith(7, [1, 2]);
  });

  it('列表 / 未读摘要 / open：只从 JWT 取 studentId，page 与 publicationId 原样透传', async () => {
    const recommendation = { recommend: vi.fn() };
    const delivery = {
      list: vi.fn().mockResolvedValue({ items: [], page: 3, pageSize: 20, total: 0 }),
      unreadSummary: vi.fn().mockResolvedValue({ count: 2, latest: { publicationId: 12, title: 'T' } }),
      open: vi.fn().mockResolvedValue({ mode: 'featured', sessionUid: 'u' }),
    };
    const controller = new StudentFeaturedSetsController(recommendation as never, delivery as never);

    await expect(controller.list('3', { sub: 7 } as never)).resolves.toEqual({
      items: [], page: 3, pageSize: 20, total: 0,
    });
    expect(delivery.list).toHaveBeenCalledWith(7, '3');
    await expect(controller.unreadCount({ sub: 7 } as never)).resolves
      .toEqual({ count: 2, latest: { publicationId: 12, title: 'T' } });
    expect(delivery.unreadSummary).toHaveBeenCalledWith(7);
    await expect(controller.open(22, { sub: 7 } as never)).resolves.toEqual({ mode: 'featured', sessionUid: 'u' });
    expect(delivery.open).toHaveBeenCalledWith(7, 22);
  });

  it('路由与角色：api/student/featured-sets + 双 guard + student，recommend 为 POST', () => {
    expect(Reflect.getMetadata(PATH_METADATA, StudentFeaturedSetsController)).toBe('api/student/featured-sets');
    expect(Reflect.getMetadata(GUARDS_METADATA, StudentFeaturedSetsController)).toEqual([JwtAuthGuard, RolesGuard]);
    expect(new Reflector().get<string[]>(ROLES_KEY, StudentFeaturedSetsController)).toEqual(['student']);
    expect(Reflect.getMetadata(METHOD_METADATA, StudentFeaturedSetsController.prototype.recommend))
      .toBe(RequestMethod.POST);
  });

  it('unread-count 在 :id/open 前声明，open 显式 200', () => {
    const proto = StudentFeaturedSetsController.prototype;
    const path = (name: keyof StudentFeaturedSetsController) =>
      Reflect.getMetadata(PATH_METADATA, proto[name] as object);
    const method = (name: keyof StudentFeaturedSetsController) =>
      Reflect.getMetadata(METHOD_METADATA, proto[name] as object);

    expect(path('list')).toBe('/');
    expect(method('list')).toBe(RequestMethod.GET);
    expect(path('unreadCount')).toBe('unread-count');
    expect(method('unreadCount')).toBe(RequestMethod.GET);
    expect(path('open')).toBe('publications/:id/open');
    expect(method('open')).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.open as object)).toBe(200);

    const names = Object.getOwnPropertyNames(proto);
    expect(names.indexOf('unreadCount')).toBeLessThan(names.indexOf('open'));
    expect(names.indexOf('unreadCount')).toBeLessThan(names.indexOf('recommend'));
  });
});
