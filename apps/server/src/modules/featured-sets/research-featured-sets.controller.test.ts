import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ResearchFeaturedSetsController } from './research-featured-sets.controller.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { ROLES_KEY } from '../../common/decorators/roles.js';

const GUARDS_METADATA = '__guards__';
const user: JwtUser = { sub: 8, role: 'researcher' };

describe('ResearchFeaturedSetsController', () => {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 7 }),
    pendingCount: vi.fn().mockResolvedValue({ count: 3 }),
    detail: vi.fn().mockResolvedValue('detail'),
    publish: vi.fn().mockResolvedValue({ publicationId: 22 }),
    reject: vi.fn().mockResolvedValue(undefined),
    reopen: vi.fn().mockResolvedValue(undefined),
    withdraw: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new ResearchFeaturedSetsController(service as never);

  it('7 个端点只从 JWT 取 reviewer 并原样透传参数', async () => {
    await expect(controller.list('approved', '2')).resolves.toEqual({
      items: [], page: 1, pageSize: 20, total: 7,
    });
    expect(service.list).toHaveBeenCalledWith('approved', '2');
    await expect(controller.pendingCount()).resolves.toEqual({ count: 3 });
    await expect(controller.detail(5)).resolves.toBe('detail');
    expect(service.detail).toHaveBeenCalledWith(5);

    const body = { title: '八年级数学精选题', gradeCode: 'grade_8' };
    await expect(controller.publish(5, body, user)).resolves.toEqual({ publicationId: 22 });
    expect(service.publish).toHaveBeenCalledWith(5, body, user);
    await controller.reject(5, user);
    expect(service.reject).toHaveBeenCalledWith(5, user);
    await controller.reopen(5);
    expect(service.reopen).toHaveBeenCalledWith(5);
    await controller.withdraw(22, user);
    expect(service.withdraw).toHaveBeenCalledWith(22, user);
  });

  it('路由契约：researcher + 双 guard + 3 GET / 4 POST 显式 200', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ResearchFeaturedSetsController))
      .toBe('api/research/featured-sets');
    expect(Reflect.getMetadata(GUARDS_METADATA, ResearchFeaturedSetsController))
      .toEqual([JwtAuthGuard, RolesGuard]);
    expect(new Reflector().get<string[]>(ROLES_KEY, ResearchFeaturedSetsController))
      .toEqual(['researcher']);

    const proto = ResearchFeaturedSetsController.prototype;
    const path = (name: keyof ResearchFeaturedSetsController) =>
      Reflect.getMetadata(PATH_METADATA, proto[name] as object);
    const method = (name: keyof ResearchFeaturedSetsController) =>
      Reflect.getMetadata(METHOD_METADATA, proto[name] as object);

    expect(path('list')).toBe('/');
    expect(method('list')).toBe(RequestMethod.GET);
    expect(path('pendingCount')).toBe('pending-count');
    expect(method('pendingCount')).toBe(RequestMethod.GET);
    expect(path('detail')).toBe(':id');
    expect(method('detail')).toBe(RequestMethod.GET);
    expect(path('publish')).toBe(':id/publish');
    expect(path('reject')).toBe(':id/reject');
    expect(path('reopen')).toBe(':id/reopen');
    expect(path('withdraw')).toBe('publications/:id/withdraw');

    for (const name of ['publish', 'reject', 'reopen', 'withdraw'] as const) {
      expect(method(name)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto[name] as object)).toBe(HttpStatus.OK);
    }
  });

  it('pending-count 路由必须声明在 :id 之前，否则会被 :id 吞掉', () => {
    const names = Object.getOwnPropertyNames(ResearchFeaturedSetsController.prototype);
    expect(names.indexOf('pendingCount')).toBeLessThan(names.indexOf('detail'));
  });
});
