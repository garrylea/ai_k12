import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, RequestMethod, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LevelsController } from './levels.controller.js';
import { LEVELS } from './levels.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { ROLES_KEY } from '../../common/decorators/roles.js';

/**
 * Nest 元数据常量值。`@nestjs/common` 包入口未导出这些常量（内部在
 * `@nestjs/common/constants`），同 `points.controller.test.ts` / `parent-points.controller.test.ts`
 * 的用法：用字面量 + 用例钉住，防装饰器被误删。
 */
const GUARDS_METADATA = '__guards__';
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

const STUDENT: JwtUser = { sub: 7, role: 'student' };
const PARENT: JwtUser = { sub: 9, role: 'parent' };

/** 造一个只够 `JwtAuthGuard` / `RolesGuard` 用的 `ExecutionContext`。 */
function mkCtx(user: unknown, handler: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => LevelsController,
  } as unknown as ExecutionContext;
}

describe('LevelsController 路由与守卫 metadata', () => {
  it('挂在 api/points 前缀下，GET levels 是 GET 方法', () => {
    expect(Reflect.getMetadata(PATH_METADATA, LevelsController)).toBe('api/points');
    expect(Reflect.getMetadata(METHOD_METADATA, LevelsController.prototype.getLevels)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(PATH_METADATA, LevelsController.prototype.getLevels)).toBe('levels');
  });

  it('类上挂 JwtAuthGuard + RolesGuard，并同时放行 student 与 parent', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, LevelsController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));

    const roles = Reflect.getMetadata(ROLES_KEY, LevelsController) as string[];
    expect(roles).toEqual(expect.arrayContaining(['student', 'parent']));
  });
});

describe('LevelsController 守卫行为', () => {
  const jwtGuard = new JwtAuthGuard();
  const rolesGuard = new RolesGuard(new Reflector());
  const handler = LevelsController.prototype.getLevels;

  const run = (user: unknown) => {
    const context = mkCtx(user, handler);
    jwtGuard.canActivate(context);
    rolesGuard.canActivate(context);
  };

  it('无 token → 401', () => {
    expect(() => run(undefined)).toThrow(UnauthorizedException);
  });

  it('学生 token 与家长 token 都放行', () => {
    expect(() => run(STUDENT)).not.toThrow();
    expect(() => run(PARENT)).not.toThrow();
  });

  it('管理员 token 被拒（只放行 student/parent）', () => {
    expect(() => run({ sub: 1, role: 'admin' })).toThrow(ForbiddenException);
  });
});

describe('LevelsController.getLevels', () => {
  const controller = new LevelsController();

  it('返回全部 9 个段位，首项劈柴/0、末项王者/20000', () => {
    const { levels } = controller.getLevels();

    expect(levels).toHaveLength(9);
    expect(levels[0]).toMatchObject({ code: 'pichai', name: '劈柴', threshold: 0 });
    expect(levels[8]).toMatchObject({ code: 'wangzhe', name: '王者', threshold: 20000 });
  });

  it('阈值严格递增，index 与数组下标一致', () => {
    const { levels } = controller.getLevels();

    for (let i = 0; i < levels.length; i++) {
      expect(levels[i].index).toBe(i);
      expect(levels[i].threshold).toBe(LEVELS[i].threshold);
      if (i > 0) expect(levels[i].threshold).toBeGreaterThan(levels[i - 1].threshold);
    }
  });

  it('不做任何 DB 访问（无构造依赖、纯静态常量）', () => {
    // 构造器零参即可实例化：若误注入仓储/服务，这里会直接抛「需传参」
    expect(() => new LevelsController()).not.toThrow();
  });
});
