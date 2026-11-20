import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../../database/database.module.js';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import { ResearchModule } from './research.module.js';
import { ResearchImagesController } from './research-images.controller.js';
import { ResearchImagesService } from './research-images.service.js';

let moduleRef: TestingModule | undefined;

afterEach(async () => {
  await moduleRef?.close();
  moduleRef = undefined;
});

/** 真实模块编译：直接验证 AppModule 同构的 DI 图能解析清理服务的全部构造依赖。 */
describe('ResearchModule — 图片清理依赖可解析（bootstrap 守卫）', () => {
  it('ResearchImagesController / ResearchImagesService / UploadedFilesRepository 均可从模块解析', async () => {
    const pool = {
      execute: vi.fn().mockResolvedValue([[], []]),
      query: vi.fn().mockResolvedValue([[], []]),
      getConnection: vi.fn(),
    };

    moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, ResearchModule], // 与 AppModule 相同的全局 DB 注入路径
    })
      .overrideProvider('DATABASE_POOL').useValue(pool)
      .compile();

    expect(moduleRef.get(ResearchImagesController)).toBeInstanceOf(ResearchImagesController);
    expect(moduleRef.get(ResearchImagesService)).toBeInstanceOf(ResearchImagesService);
    expect(moduleRef.get(UploadedFilesRepository)).toBeInstanceOf(UploadedFilesRepository);
  });

  it('ResearchModule.providers 显式提供 UploadedFilesRepository（不只靠 FilesModule 内部）', async () => {
    const { MODULE_METADATA } = await import('@nestjs/common/constants');
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ResearchModule) as unknown[];
    expect(providers).toContain(UploadedFilesRepository);
  });
});
