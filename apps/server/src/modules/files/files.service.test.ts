import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

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
