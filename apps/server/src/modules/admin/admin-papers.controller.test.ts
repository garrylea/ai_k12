import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { AdminPapersController } from './admin-papers.controller.js';
import type { AdminPapersService } from './admin-papers.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { ROLES_KEY } from '../../common/decorators/roles.js';

const GUARDS_METADATA = '__guards__';

function makeController() {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    preview: vi.fn().mockResolvedValue({ paperId: 1 }),
    remove: vi.fn().mockResolvedValue({ paperId: 1 }),
  };
  return { controller: new AdminPapersController(service as unknown as AdminPapersService), service };
}

describe('AdminPapersController 路由形状', () => {
  it('类前缀 api/admin/papers，且挂 JwtAuthGuard + RolesGuard + admin 角色', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminPapersController)).toBe('api/admin/papers');
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminPapersController) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
    expect(new Reflector().get<string[]>(ROLES_KEY, AdminPapersController)).toEqual(['admin']);
  });

  it('三个方法的路由与方法', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminPapersController.prototype.list)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, AdminPapersController.prototype.list)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, AdminPapersController.prototype.preview)).toBe(':id/delete-preview');
    expect(Reflect.getMetadata(METHOD_METADATA, AdminPapersController.prototype.preview)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, AdminPapersController.prototype.remove)).toBe(':id');
    expect(Reflect.getMetadata(METHOD_METADATA, AdminPapersController.prototype.remove)).toBe(RequestMethod.DELETE);
  });
});

describe('AdminPapersController.list 入参', () => {
  it('空 query → 默认 page=1 pageSize=20，空字符串不当作非法数字', async () => {
    const { controller, service } = makeController();
    await controller.list({ subjectId: '', year: '', gradeBand: '', keyword: '' });
    expect(service.list).toHaveBeenCalledWith({ subjectId: undefined, year: undefined, gradeBand: undefined, keyword: undefined, page: 1, pageSize: 20 });
  });

  it('非法 gradeBand / pageSize / subjectId → 400（不是 500）', async () => {
    const { controller } = makeController();
    expect(() => controller.list({ gradeBand: 'foo' })).toThrow(BadRequestException);
    expect(() => controller.list({ pageSize: '101' })).toThrow(BadRequestException);
    expect(() => controller.list({ pageSize: '0' })).toThrow(BadRequestException);
    expect(() => controller.list({ subjectId: 'abc' })).toThrow(BadRequestException);
  });

  it('合法参数原样透传（数字从字符串 coerce）', async () => {
    const { controller, service } = makeController();
    await controller.list({ subjectId: '9', year: '2026', gradeBand: 'junior', keyword: ' 汇文 ', page: '2', pageSize: '10' });
    expect(service.list).toHaveBeenCalledWith({ subjectId: 9, year: 2026, gradeBand: 'junior', keyword: '汇文', page: 2, pageSize: 10 });
  });
});
