import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AIController } from './ai.controller.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { ROLES_KEY } from '../../common/decorators/roles.js';

/**
 * Nest 元数据常量值。`@nestjs/common` 包入口未导出这些常量（内部在
 * `@nestjs/common/constants`），同 `levels.controller.test.ts` 的用法：
 * 用字面量 + 用例钉住，防装饰器被误删。
 */
const GUARDS_METADATA = '__guards__';
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

/** 造一个只够 `JwtAuthGuard` / `RolesGuard` 用的 `ExecutionContext`。 */
function mkCtx(user: unknown, handler: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => AIController,
  } as unknown as ExecutionContext;
}

describe('AIController — 手写转写端点守卫', () => {
  it('继承类级 @Roles(student)；路由为 POST api/ai/handwriting/transcribe', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AIController);
    expect(roles).toEqual(['student']);
    const path = Reflect.getMetadata(PATH_METADATA, AIController.prototype.transcribeHandwriting);
    expect(path).toBe('handwriting/transcribe');
    const method = Reflect.getMetadata(METHOD_METADATA, AIController.prototype.transcribeHandwriting);
    expect(method).toBe(1); // RequestMethod.POST
  });
});

describe('AIController 守卫行为（实际运行 JwtAuthGuard + RolesGuard）', () => {
  const jwtGuard = new JwtAuthGuard();
  const rolesGuard = new RolesGuard(new Reflector());
  const handler = AIController.prototype.transcribeHandwriting;

  const run = (user: unknown) => {
    const context = mkCtx(user, handler);
    jwtGuard.canActivate(context);
    rolesGuard.canActivate(context);
  };

  it('无 token → 401', () => {
    expect(() => run(undefined)).toThrow(UnauthorizedException);
  });

  it('学生 token 放行', () => {
    const student: JwtUser = { sub: 7, role: 'student' };
    expect(() => run(student)).not.toThrow();
  });

  it('家长 token → 403', () => {
    const parent: JwtUser = { sub: 9, role: 'parent' };
    expect(() => run(parent)).toThrow(ForbiddenException);
  });
});
