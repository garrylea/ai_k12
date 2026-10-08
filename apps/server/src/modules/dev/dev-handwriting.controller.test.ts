import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DevHandwritingController } from './dev-handwriting.controller.js';
import { DevHandwritingService } from './dev-handwriting.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { ROLES_KEY } from '../../common/decorators/roles.js';

/**
 * Nest 的 `GUARDS_METADATA` 常量值（`@nestjs/common` 未从包入口导出），
 * 用字面量 + 用例钉住，防装饰器被误删——同 points.controller.test.ts 先例。
 */
const GUARDS_METADATA = '__guards__';

const ADMIN = { sub: 1, role: 'admin' } as const;
const PARENT = { sub: 9, role: 'parent' } as const;
const STUDENT = { sub: 7, role: 'student' } as const;

/** 造一个只够 `JwtAuthGuard` / `RolesGuard` 用的 `ExecutionContext`。 */
function mkCtx(user: unknown, handler: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => DevHandwritingController,
  } as unknown as ExecutionContext;
}

/** 造一个 controller：service 全 mock，不连库。 */
function makeController() {
  const service = { listModels: vi.fn(), recognize: vi.fn() };
  const controller = new DevHandwritingController(service as unknown as DevHandwritingService);
  return { controller, service };
}

describe('DevHandwritingController 守卫', () => {
  const jwtGuard = new JwtAuthGuard();
  const rolesGuard = new RolesGuard(new Reflector());

  // 按 Nest 的注册顺序依次跑：先 JwtAuthGuard（无 token → 401），再 RolesGuard（角色不符 → 403）
  const run = (user: unknown) => {
    const context = mkCtx(user, DevHandwritingController.prototype.recognize);
    jwtGuard.canActivate(context);
    rolesGuard.canActivate(context);
  };

  it('类上挂了 JwtAuthGuard + RolesGuard，且 @Roles("admin")（2026-10-08 用户裁决收窄）', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, DevHandwritingController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));
    expect(Reflect.getMetadata(ROLES_KEY, DevHandwritingController)).toEqual(['admin']);
  });

  it('家长 token → 403', () => {
    expect(() => run(PARENT)).toThrow(ForbiddenException);
  });

  it('学生 token → 403', () => {
    expect(() => run(STUDENT)).toThrow(ForbiddenException);
  });

  it('无 token → 401', () => {
    expect(() => run(undefined)).toThrow(UnauthorizedException);
  });

  it('admin token → 放行', () => {
    expect(() => run(ADMIN)).not.toThrow();
  });
});

describe('DevHandwritingController.recognize', () => {
  it('请求体缺失 / 键缺失 → 400，service 不被调', () => {
    const { controller, service } = makeController();
    for (const dto of [undefined, {}, { image: 'data:image/png;base64,AAA' }, { modelKey: 'k' }]) {
      expect(() => controller.recognize(dto as never)).toThrow(BadRequestException);
    }
    expect(service.recognize).not.toHaveBeenCalled();
  });

  it('请求体齐全 → 原样透传 service', () => {
    const { controller, service } = makeController();
    service.recognize.mockResolvedValue({ text: 'x', modelKey: 'k', elapsedMs: 1 });
    const image = 'data:image/png;base64,AAA';
    controller.recognize({ image, modelKey: 'k' });
    expect(service.recognize).toHaveBeenCalledWith(image, 'k');
  });
});
