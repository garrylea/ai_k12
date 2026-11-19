import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import {
  INTERCEPTORS_METADATA, METHOD_METADATA, PATH_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import {
  researchImageFileFilter, ResearchImagesController,
} from './research-images.controller.js';
import type { ResearchImagesService } from './research-images.service.js';
import type { FilesService } from '../files/files.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { ROLES_KEY } from '../../common/decorators/roles.js';

const GUARDS_METADATA = '__guards__';
const USER = { sub: 7, role: 'researcher', name: '教研员' } as any;
const URL_A = '/uploads/research/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';

function makeController() {
  const service = {
    cleanupUnreferenced: vi.fn().mockResolvedValue({ deleted: 1, skipped: 0 }),
    gc: vi.fn().mockResolvedValue({ scanned: 1, deleted: 1, skipped: 0, failed: 0 }),
  };
  const files = { store: vi.fn().mockResolvedValue({ fileId: 5, url: URL_A }) };
  const controller = new ResearchImagesController(
    service as unknown as ResearchImagesService,
    files as unknown as FilesService,
  );
  return { controller, service, files };
}

describe('ResearchImagesController 路由形状', () => {
  it('类前缀 api/research/images + 双守卫 + researcher 角色', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ResearchImagesController)).toBe('api/research/images');
    expect(Reflect.getMetadata(GUARDS_METADATA, ResearchImagesController))
      .toEqual([JwtAuthGuard, RolesGuard]);
    expect(new Reflector().get<string[]>(ROLES_KEY, ResearchImagesController))
      .toEqual(['researcher']);
  });

  it('三端点方法与路径匹配 spec §7.7/7.8/7.9', () => {
    expect(Reflect.getMetadata(METHOD_METADATA, ResearchImagesController.prototype.upload))
      .toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, ResearchImagesController.prototype.upload))
      .toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, ResearchImagesController.prototype.remove))
      .toBe(RequestMethod.DELETE);
    expect(Reflect.getMetadata(PATH_METADATA, ResearchImagesController.prototype.remove))
      .toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, ResearchImagesController.prototype.gc))
      .toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, ResearchImagesController.prototype.gc))
      .toBe('gc');
  });

  it('上传端点挂 FileInterceptor', () => {
    const interceptors = Reflect.getMetadata(
      INTERCEPTORS_METADATA, ResearchImagesController.prototype.upload,
    ) as unknown[];
    expect(interceptors).toBeDefined();
    expect(interceptors.length).toBeGreaterThan(0);
  });
});

describe('researchImageFileFilter — MIME 白名单 image/*', () => {
  const file = (mimetype: string) => ({ mimetype } as Express.Multer.File);

  it('image/png、image/jpeg 接收', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
      const cb = vi.fn();
      researchImageFileFilter({}, file(mime), cb);
      expect(cb).toHaveBeenCalledWith(null, true);
    }
  });

  it('application/pdf 等非图 → 400/1001', () => {
    const cb = vi.fn();
    researchImageFileFilter({}, file('application/pdf'), cb);
    const [err, accept] = cb.mock.calls[0] as [BadRequestException, boolean];
    expect(accept).toBe(false);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ code: 1001 });
  });
});

describe('ResearchImagesController 入参转发', () => {
  const uploaded = { mimetype: 'image/png', originalname: 'a.png' } as Express.Multer.File;

  it('upload 调 files.store(file, sub, research, researcher)', async () => {
    const { controller, files } = makeController();
    const res = await controller.upload(uploaded, USER);
    expect(files.store).toHaveBeenCalledWith(uploaded, 7, 'research', 'researcher');
    expect(res).toEqual({ fileId: 5, url: URL_A });
  });

  it('upload 缺文件 → 400/1001', () => {
    const { controller, files } = makeController();
    expect(() => controller.upload(undefined as unknown as Express.Multer.File, USER))
      .toThrow(BadRequestException);
    expect(files.store).not.toHaveBeenCalled();
  });

  it('remove 校验 urls 后连 actor 一起交给 service', async () => {
    const { controller, service } = makeController();
    await controller.remove({ urls: [URL_A] }, USER);
    expect(service.cleanupUnreferenced).toHaveBeenCalledWith([URL_A], USER);
  });

  it.each([
    { urls: 'not-array' },
    { urls: [123] },
    {},
  ])('remove 非法 body → 400：%j', (body) => {
    const { controller, service } = makeController();
    expect(() => controller.remove(body as any, USER)).toThrow(BadRequestException);
    expect(service.cleanupUnreferenced).not.toHaveBeenCalled();
  });
});

describe('ResearchImagesController.gc 入参', () => {
  it('body 缺省 → 24 小时', async () => {
    const { controller, service } = makeController();
    await controller.gc(undefined, USER);
    expect(service.gc).toHaveBeenCalledWith(24, USER);
  });

  it('合法 48 小时原样透传', async () => {
    const { controller, service } = makeController();
    await controller.gc({ olderThanHours: 48 }, USER);
    expect(service.gc).toHaveBeenCalledWith(48, USER);
  });

  it.each([0, 721, 1.5, '24', NaN])('非法 olderThanHours → 400：%s', (hours) => {
    const { controller, service } = makeController();
    expect(() => controller.gc({ olderThanHours: hours as number }, USER))
      .toThrow(BadRequestException);
    expect(service.gc).not.toHaveBeenCalled();
  });
});
