import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { StudentFeaturedSetsController } from './student-featured-sets.controller.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { ROLES_KEY } from '../../common/decorators/roles.js';

const GUARDS_METADATA = '__guards__';

describe('StudentFeaturedSetsController', () => {
  it('学生推荐：POST 201 且只从 JWT 取 studentId', async () => {
    const service = { recommend: vi.fn().mockResolvedValue({ setId: 3, alreadyRecommended: false }) };
    const controller = new StudentFeaturedSetsController(service as never);

    await expect(controller.recommend({ questionIds: [1, 2] }, { sub: 7 } as never))
      .resolves.toEqual({ setId: 3, alreadyRecommended: false });
    expect(service.recommend).toHaveBeenCalledWith(7, [1, 2]);
  });

  it('路由与角色：api/student/featured-sets + 双 guard + student，recommend 为 POST', () => {
    expect(Reflect.getMetadata(PATH_METADATA, StudentFeaturedSetsController)).toBe('api/student/featured-sets');
    expect(Reflect.getMetadata(GUARDS_METADATA, StudentFeaturedSetsController)).toEqual([JwtAuthGuard, RolesGuard]);
    expect(new Reflector().get<string[]>(ROLES_KEY, StudentFeaturedSetsController)).toEqual(['student']);
    expect(Reflect.getMetadata(METHOD_METADATA, StudentFeaturedSetsController.prototype.recommend))
      .toBe(RequestMethod.POST);
  });
});
