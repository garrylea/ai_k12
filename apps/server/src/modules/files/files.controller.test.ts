import { describe, expect, it, vi } from 'vitest';
import { FilesController } from './files.controller.js';

const file = {
  mimetype: 'image/jpeg',
  size: 10,
  originalname: 'a.jpg',
  buffer: Buffer.from(''),
} as any;
const user = { sub: 1 } as any;

describe('FilesController POST /api/files/upload', () => {
  it('source=freeform 透传给 service', async () => {
    const service = {
      upload: vi.fn().mockResolvedValue({ fileId: 1, url: '/uploads/x.jpg' }),
    } as any;
    const c = new FilesController(service);
    await c.upload(file, user, 'freeform');
    expect(service.upload).toHaveBeenCalledWith(expect.anything(), 1, 'freeform');
  });

  it('source 缺省时按 auxiliary 透传', async () => {
    const service = {
      upload: vi.fn().mockResolvedValue({ fileId: 1, url: '/uploads/x.jpg' }),
    } as any;
    const c = new FilesController(service);
    await c.upload(file, user);
    expect(service.upload).toHaveBeenCalledWith(expect.anything(), 1, 'auxiliary');
  });

  it('非法 source 拒绝', async () => {
    const c = new FilesController({ upload: vi.fn() } as any);
    await expect(c.upload({} as any, user, 'evil')).rejects.toMatchObject({
      response: { code: 1001 },
    });
  });
});
