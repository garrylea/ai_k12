import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ResearchAuditController } from './research-audit.controller.js';
import type { ResearchAuditService } from './research-audit.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { ROLES_KEY } from '../../common/decorators/roles.js';

const GUARDS_METADATA = '__guards__';

function makeController() {
  const service = { list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }) };
  return { controller: new ResearchAuditController(service as unknown as ResearchAuditService), service };
}

describe('ResearchAuditController', () => {
  it('路由与角色：api/research/audit + 双 guard + researcher', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ResearchAuditController)).toBe('api/research/audit');
    expect(Reflect.getMetadata(GUARDS_METADATA, ResearchAuditController)).toEqual([JwtAuthGuard, RolesGuard]);
    expect(new Reflector().get<string[]>(ROLES_KEY, ResearchAuditController)).toEqual(['researcher']);
    expect(Reflect.getMetadata(METHOD_METADATA, ResearchAuditController.prototype.list)).toBe(RequestMethod.GET);
  });

  it('非法 ISO 时间 → 400/1001', () => {
    const { controller } = makeController();
    expect(() => controller.list({ from: 'not-a-date' })).toThrow(BadRequestException);
    try {
      controller.list({ to: '2026-13-99' });
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toMatchObject({ code: 1001 });
    }
  });

  it('合法 ISO 转 Date 后传给 service，空字符串视为未填', async () => {
    const { controller, service } = makeController();
    await controller.list({
      action: 'paper.delete', targetType: 'paper', from: '2026-11-01T00:00:00.000Z',
      to: '', page: '2', pageSize: '10',
    });
    expect(service.list).toHaveBeenCalledWith({
      actorId: undefined, action: 'paper.delete', targetType: 'paper', targetId: undefined,
      from: new Date('2026-11-01T00:00:00.000Z'), to: undefined, page: 2, pageSize: 10,
    });
  });
});
