import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { UnauthorizedException } from '@nestjs/common';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles';

const dummyClass = function DummyClass() {};
dummyClass.prototype = Object.create(Object.prototype);

const mkCtx = (user: unknown, handler: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => dummyClass,
  }) as any;

describe('RolesGuard', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  it('无角色元数据 -> 放行', () => {
    const handler = () => {};
    expect(guard.canActivate(mkCtx({ sub: 1, role: 'parent' }, handler))).toBe(true);
  });

  it('角色匹配 -> 放行；不匹配 -> 抛 403', () => {
    const handler = () => {};
    Reflect.defineMetadata(ROLES_KEY, ['student'], handler);
    expect(guard.canActivate(mkCtx({ sub: 1, role: 'student' }, handler))).toBe(true);
    expect(() => guard.canActivate(mkCtx({ sub: 1, role: 'parent' }, handler))).toThrow();
  });

  it('未登录 -> 抛 UnauthorizedException', () => {
    const handler = () => {};
    Reflect.defineMetadata(ROLES_KEY, ['student'], handler);
    expect(() => guard.canActivate(mkCtx(undefined, handler))).toThrow(UnauthorizedException);
  });
});
