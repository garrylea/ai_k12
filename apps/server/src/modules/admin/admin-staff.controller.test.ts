import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminStaffController } from './admin-staff.controller.js';
import type { AdminStaffService } from './admin-staff.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';

const GUARDS_METADATA = '__guards__';
const METHOD_METADATA = 'method';
const PATH_METADATA = 'path';

function makeController() {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [] }),
    create: vi.fn().mockResolvedValue({ id: 11, username: 'r22', name: null, isActive: true }),
    setStatus: vi.fn().mockResolvedValue(undefined),
    resetPassword: vi.fn().mockResolvedValue(undefined),
  };
  return { controller: new AdminStaffController(service as unknown as AdminStaffService), service };
}

describe('AdminStaffController 路由与守卫', () => {
  it('类路径 api/admin/staff；4 个端点路径与方法正确', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminStaffController)).toBe('api/admin/staff');
    expect(Reflect.getMetadata(PATH_METADATA, AdminStaffController.prototype.list)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, AdminStaffController.prototype.list)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, AdminStaffController.prototype.create)).toBe('/');
    // @Post 默认 201，创建语义正确
    expect(Reflect.getMetadata(METHOD_METADATA, AdminStaffController.prototype.create)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, AdminStaffController.prototype.setStatus)).toBe(':id/status');
    expect(Reflect.getMetadata(METHOD_METADATA, AdminStaffController.prototype.setStatus)).toBe(RequestMethod.PATCH);
    expect(Reflect.getMetadata(PATH_METADATA, AdminStaffController.prototype.resetPassword)).toBe(':id/password');
    expect(Reflect.getMetadata(METHOD_METADATA, AdminStaffController.prototype.resetPassword)).toBe(RequestMethod.PATCH);
  });

  it('类级 JwtAuthGuard + RolesGuard + @Roles("admin")', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminStaffController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));
    expect(new Reflector().get<string[]>('roles', AdminStaffController)).toEqual(['admin']);
  });
});

describe('AdminStaffController 委派与校验', () => {
  it('GET 去空格并截断 50 字后委派 list', async () => {
    const { controller, service } = makeController();
    await controller.list(`  ${'a'.repeat(60)}  `);
    expect(service.list).toHaveBeenCalledWith('a'.repeat(50));

    await controller.list();
    expect(service.list).toHaveBeenLastCalledWith('');
  });

  it('POST 委派 create，name 可省略', async () => {
    const { controller, service } = makeController();
    await expect(controller.create({ username: 'r22', password: 'pass123' }))
      .resolves.toMatchObject({ id: 11 });
    expect(service.create).toHaveBeenCalledWith({ username: 'r22', password: 'pass123' });
  });

  it('POST body 带 role → 400/1001（绝不创建 admin）', async () => {
    const { controller, service } = makeController();
    await expect(controller.create({ username: 'r22', password: 'pass123', role: 'admin' }))
      .rejects.toMatchObject({ status: 400, response: { code: 1001 } });
    expect(service.create).not.toHaveBeenCalled();
  });

  it('POST 用户名/密码/姓名不合法 → 400/1001', async () => {
    const { controller, service } = makeController();
    const bads = [
      { username: 'ab', password: 'pass123' },
      { username: 'bad-name', password: 'pass123' },
      { username: 'r22', password: '12345' },
      { username: 'r22', password: 'a'.repeat(73) },
      { username: 'r22', password: 'pass123', name: 'x'.repeat(51) },
    ];
    for (const body of bads) {
      await expect(controller.create(body)).rejects.toMatchObject({ status: 400, response: { code: 1001 } });
    }
    expect(service.create).not.toHaveBeenCalled();
  });

  it('PATCH status 委派；非布尔 → 400', async () => {
    const { controller, service } = makeController();
    await controller.setStatus(7, { isActive: false });
    expect(service.setStatus).toHaveBeenCalledWith(7, false);

    await expect(controller.setStatus(7, { isActive: 'false' }))
      .rejects.toMatchObject({ status: 400, response: { code: 1001 } });
    expect(service.setStatus).toHaveBeenCalledTimes(1);
  });

  it('PATCH password 委派；6-72 位之外 → 400', async () => {
    const { controller, service } = makeController();
    await controller.resetPassword(7, { password: 'newpass1' });
    expect(service.resetPassword).toHaveBeenCalledWith(7, 'newpass1');

    await expect(controller.resetPassword(7, { password: '12345' }))
      .rejects.toMatchObject({ status: 400, response: { code: 1001 } });
    expect(service.resetPassword).toHaveBeenCalledTimes(1);
  });
});
