import { describe, expect, it, vi } from 'vitest';
import { UploadedFilesRepository } from './uploaded-files.repo.js';

const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([[], []]),
});

describe('UploadedFilesRepository.findByUrlAndOwner', () => {
  it('按 url + uploader_id 查询（归属过滤不能少）', async () => {
    const pool = mockPool();
    const repo = new UploadedFilesRepository(pool as any);

    await repo.findByUrlAndOwner('/uploads/freeform/a.jpg', 7);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('WHERE url = ? AND uploader_id = ?');
    expect(params).toEqual(['/uploads/freeform/a.jpg', 7]);
  });

  it('命中时返回整行', async () => {
    const pool = mockPool();
    const row = {
      id: 3,
      uploader_id: 7,
      uploader_type: 'student',
      url: '/uploads/freeform/a.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 10,
      source: 'freeform',
      created_at: new Date('2026-11-08T00:00:00Z'),
    };
    pool.execute.mockResolvedValueOnce([[row], []]);
    const repo = new UploadedFilesRepository(pool as any);

    await expect(repo.findByUrlAndOwner('/uploads/freeform/a.jpg', 7)).resolves.toEqual(row);
  });

  it('未命中返回 null（不抛错）', async () => {
    const pool = mockPool();
    const repo = new UploadedFilesRepository(pool as any);

    await expect(repo.findByUrlAndOwner('/uploads/missing.jpg', 7)).resolves.toBeNull();
  });
});

describe('UploadedFilesRepository.findByUrl / delete', () => {
  it('findByUrl 只按 url 精确查，delete 调 DELETE', async () => {
    const pool = mockPool();
    const repo = new UploadedFilesRepository(pool as any);

    await repo.findByUrl('/uploads/research/x.png');
    expect(pool.execute).toHaveBeenCalledWith(
      'SELECT * FROM uploaded_files WHERE url = ? LIMIT 1',
      ['/uploads/research/x.png'],
    );

    await repo.delete(5);
    expect(pool.execute).toHaveBeenCalledWith('DELETE FROM uploaded_files WHERE id = ?', [5]);
  });

  it('findByUrl 命中返回整行、未命中返回 null', async () => {
    const pool = mockPool();
    const row = {
      id: 3,
      uploader_id: 7,
      uploader_type: 'researcher',
      url: '/uploads/research/x.png',
      mime_type: 'image/png',
      size_bytes: 10,
      source: 'research',
      created_at: new Date('2026-11-19T00:00:00Z'),
    };
    pool.execute.mockResolvedValueOnce([[row], []]);
    const repo = new UploadedFilesRepository(pool as any);
    await expect(repo.findByUrl('/uploads/research/x.png')).resolves.toEqual(row);

    pool.execute.mockResolvedValueOnce([[], []]);
    await expect(repo.findByUrl('/uploads/missing.png')).resolves.toBeNull();
  });
});
