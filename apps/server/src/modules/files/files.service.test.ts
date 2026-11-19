import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import * as fs from 'node:fs/promises';
import { FilesService } from './files.service.js';

function makeFile(mimetype: string, originalname: string) {
  return {
    mimetype,
    size: 10,
    originalname,
    buffer: Buffer.from('x'),
  } as unknown as Express.Multer.File;
}

function setup() {
  const filesRepo = { create: vi.fn().mockResolvedValue(1) };
  const refineryService = { createTask: vi.fn().mockResolvedValue(99) };
  const service = new FilesService(filesRepo as any, refineryService as any);
  return { service, filesRepo, refineryService };
}

beforeEach(() => {
  process.env.UPLOAD_DIR = '/tmp/ai-k12-upload-test';
});

describe('FilesService.upload — PDF extraction auto-start', () => {
  it('source=freeform + application/pdf 不启动 refinery，结果无 taskId', async () => {
    const { service, filesRepo, refineryService } = setup();

    const result = await service.upload(makeFile('application/pdf', 'a.pdf'), 7, 'freeform');

    expect(filesRepo.create).toHaveBeenCalledTimes(1);
    expect(refineryService.createTask).not.toHaveBeenCalled();
    expect(result).toEqual({ fileId: 1, url: expect.any(String), taskId: undefined });
    expect('taskId' in result && result.taskId !== undefined).toBe(false);
  });

  it('source=auxiliary + application/pdf 以 (fileId, uploaderId, auxiliary) 启动 refinery，结果带 taskId', async () => {
    const { service, refineryService } = setup();

    const result = await service.upload(makeFile('application/pdf', 'a.pdf'), 7, 'auxiliary');

    expect(refineryService.createTask).toHaveBeenCalledWith(1, 7, 'auxiliary');
    expect(result.taskId).toBe(99);
  });

  it('JPEG 上传无论 source 都不启动 refinery', async () => {
    for (const source of ['auxiliary', 'freeform']) {
      const { service, refineryService } = setup();

      const result = await service.upload(makeFile('image/jpeg', 'a.jpg'), 7, source);

      expect(refineryService.createTask).not.toHaveBeenCalled();
      expect(result.taskId).toBeUndefined();
    }
  });
});

describe('FilesService.store — 按调用方指定 role/source 落盘', () => {
  it('store() 落盘到 research 子目录并按角色写 uploader_type', async () => {
    const { service, filesRepo } = setup();
    const file = makeFile('image/png', 'a.png');

    const res = await service.store(file, 7, 'research', 'researcher');

    expect(res.url).toMatch(/^\/uploads\/research\/[0-9a-f-]+\.png$/);
    expect(filesRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      uploader_id: 7, uploader_type: 'researcher', source: 'research',
    }));
    // 真正写到磁盘的 research 子目录（不是只在 DB 里写 research 前缀）
    const dest = vi.mocked(fs.writeFile).mock.calls.at(-1)![0] as string;
    expect(dest).toMatch(/\/research\/[0-9a-f-]+\.png$/);
  });

  it('upload() 薄包装仍以 student 身份落库（学生行为不变）', async () => {
    const { service, filesRepo } = setup();

    await service.upload(makeFile('image/png', 'a.png'), 7, 'research');

    expect(filesRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      uploader_id: 7, uploader_type: 'student', source: 'research',
    }));
  });

  it('research 来源的 PDF 也遵守 source !== freeform 的自动建任务条件', async () => {
    const { service, refineryService } = setup();

    await service.store(makeFile('application/pdf', 'a.pdf'), 7, 'research', 'researcher');

    expect(refineryService.createTask).toHaveBeenCalledWith(1, 7, 'research');
  });
});
