import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * 内存 fs 替身：识别服务要读 MinerU 输出、复制题图、落盘配图。
 * 全部走 mock，测试不碰真实磁盘（也不会在 CI 上留下 /tmp 垃圾）。
 */
const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(),
  copyFile: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:fs/promises', () => fsMock);

import { HttpException } from '@nestjs/common';
import { FreeformRecognizeService } from './freeform-recognize.service.js';

const JPEG_ROW = { id: 1, url: '/uploads/a.jpg', mime_type: 'image/jpeg', size_bytes: 10 };

beforeAll(() => {
  process.env.UPLOAD_DIR = '/tmp/u';
});

beforeEach(() => {
  process.env.UPLOAD_DIR = '/tmp/u';
  for (const fn of Object.values(fsMock)) fn.mockReset();
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.copyFile.mockResolvedValue(undefined);
  fsMock.readdir.mockImplementation(async (dir: string) =>
    dir.endsWith('images') ? ['a.jpg'] : ['page_01.md'],
  );
  fsMock.readFile.mockResolvedValue('已知 ![a](images/a.jpg)');
  fsMock.stat.mockResolvedValue({ size: 10 });
  fsMock.rm.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.UPLOAD_DIR;
});

function makeService(overrides: {
  mineru?: any;
  split?: any;
  files?: any;
} = {}) {
  const mineru = overrides.mineru ?? { run: vi.fn().mockResolvedValue(undefined) };
  const split = overrides.split ?? { split: vi.fn().mockResolvedValue([]) };
  const files =
    overrides.files ??
    {
      findByIdAndOwner: vi.fn().mockResolvedValue(JPEG_ROW),
      create: vi.fn().mockResolvedValue(1),
    };
  const svc = new FreeformRecognizeService(mineru, split, files);
  return { svc, mineru, split, files };
}

/** 断言抛出 HttpException，并核对 HTTP 状态码与业务 code。 */
async function expectHttpError(p: Promise<unknown>, status: number, code: number): Promise<HttpException> {
  const err: unknown = await p.then(
    () => {
      throw new Error('应当抛错，但成功返回了');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpException);
  const http = err as HttpException;
  expect(http.getStatus()).toBe(status);
  expect(http.getResponse()).toMatchObject({ code });
  return http;
}

describe('纯文字短路', () => {
  it('不调 MinerU/切题，直接返回一个候选', async () => {
    const { svc, mineru, split, files } = makeService();
    const r = await svc.recognize({ text: '已知 x+1=2', fileIds: [] }, 1);

    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      no: '1',
      content: '已知 x+1=2',
      figureUrls: [],
      suggestedSubject: null,
      confidence: 1,
    });
    expect(r.figures).toEqual([]);
    expect(mineru.run).not.toHaveBeenCalled();
    expect(split.split).not.toHaveBeenCalled();
    expect(files.findByIdAndOwner).not.toHaveBeenCalled();
    expect(fsMock.mkdir).not.toHaveBeenCalled();
    expect(fsMock.rm).not.toHaveBeenCalled();
  });

  it('文字两端空白会被裁掉', async () => {
    const { svc } = makeService();
    const r = await svc.recognize({ text: '  已知 x+1=2  ' }, 1);
    expect(r.candidates[0].content).toBe('已知 x+1=2');
  });

  it('文字超过 20000 字 → 400 / code 1001', async () => {
    const { svc } = makeService();
    const err = await expectHttpError(
      svc.recognize({ text: 'a'.repeat(20001), fileIds: [] }, 1),
      400,
      1001,
    );
    expect(err.getResponse()).toMatchObject({ message: '题目文字过长' });
  });

  it('既没有文字也没有图片 → 400 / code 1001', async () => {
    const { svc } = makeService();
    const err = await expectHttpError(svc.recognize({ text: '   ' }, 1), 400, 1001);
    expect(err.getResponse()).toMatchObject({ message: '请上传题目图片或输入题目文字' });
  });
});

describe('图片流程', () => {
  it('校验+按顺序复制+调 MinerU+重写配图+返回候选', async () => {
    const mineru = { run: vi.fn().mockResolvedValue(undefined) };
    const split = {
      split: vi.fn().mockResolvedValue([
        {
          no: '5',
          content: '已知 ![a](images/a.jpg)',
          figureRefs: ['images/a.jpg'],
          suggestedSubject: 'math',
          confidence: 0.9,
          selectedHint: false,
        },
      ]),
    };
    const files = {
      findByIdAndOwner: vi.fn().mockResolvedValue(JPEG_ROW),
      create: vi.fn().mockResolvedValue(7),
    };
    const { svc } = makeService({ mineru, split, files });

    const r = await svc.recognize({ text: '第5题', fileIds: ['1'] }, 1);

    // 归属：按 studentId 校验文件所有权
    expect(files.findByIdAndOwner).toHaveBeenCalledWith(1, 1);
    // MinerU：页图先复制进临时目录，再整批交给 runner
    expect(fsMock.copyFile).toHaveBeenNthCalledWith(
      1,
      '/tmp/u/a.jpg',
      expect.stringMatching(/freeform-recognize-[^/]+\/page_01\.jpg$/),
    );
    expect(mineru.run).toHaveBeenCalledTimes(1);
    const [pages, outDir] = mineru.run.mock.calls[0];
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatch(/page_01\.jpg$/);
    expect(outDir).toMatch(/freeform-recognize-[^/]+\/out$/);

    // 配图：复制到公开目录并登记 uploaded_files
    const destCopy = fsMock.copyFile.mock.calls.find(([src]: string[]) => src.endsWith('/out/images/a.jpg'));
    expect(destCopy).toBeDefined();
    expect(destCopy![1]).toMatch(/^\/tmp\/u\/freeform\/[0-9a-f-]{36}\/a\.jpg$/);
    expect(files.create).toHaveBeenCalledWith({
      uploader_id: 1,
      uploader_type: 'student',
      url: expect.stringMatching(/^\/uploads\/freeform\/[0-9a-f-]{36}\/a\.jpg$/),
      mime_type: 'image/jpeg',
      size_bytes: 10,
      source: 'freeform_figure',
    });

    // 切题：拿到的是重写后的 Markdown（带页码锚点）
    const splitArg = split.split.mock.calls[0][0];
    expect(splitArg.textHint).toBe('第5题');
    expect(splitArg.markdown).toContain('<!-- page 1 -->');
    expect(splitArg.markdown).toMatch(/!\[a\]\(\/uploads\/freeform\/[0-9a-f-]{36}\/a\.jpg\)/);

    // 返回形状
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      id: 'c1',
      no: '5',
      content: '已知 ![a](images/a.jpg)',
      suggestedSubject: 'math',
      confidence: 0.9,
    });
    expect(r.candidates[0].figureUrls).toEqual([files.create.mock.calls[0][0].url]);
    expect(r.figures).toEqual([
      { url: files.create.mock.calls[0][0].url, name: 'a.jpg', page: 1 },
    ]);

    // 临时目录在 finally 清掉
    expect(fsMock.rm).toHaveBeenCalledWith(
      expect.stringMatching(/freeform-recognize-[^/]+$/),
      { recursive: true, force: true },
    );
  });

  it('多张图按 fileIds 顺序命名 page_01/page_02；多页 Markdown 按文件名排序拼接', async () => {
    const ran = { id: 1, url: '/uploads/a.jpg', mime_type: 'image/jpeg', size_bytes: 10 };
    const png = { id: 2, url: '/uploads/b.png', mime_type: 'image/png', size_bytes: 10 };
    const files = {
      findByIdAndOwner: vi.fn(async (id: number) => (id === 1 ? ran : png)),
      create: vi.fn().mockResolvedValue(1),
    };
    fsMock.readdir.mockImplementation(async (dir: string) =>
      dir.endsWith('images') ? [] : ['page_02.md', 'page_01.md'],
    );
    fsMock.readFile.mockImplementation(async (p: string) =>
      p.endsWith('page_01.md') ? '第一页' : '第二页',
    );
    const split = { split: vi.fn().mockResolvedValue([]) };
    const { svc } = makeService({ files, split });

    await svc.recognize({ fileIds: ['1', '2'] }, 9);

    const copies = fsMock.copyFile.mock.calls.map(([src, dst]: string[]) => [src, dst]);
    expect(copies[0][1]).toMatch(/page_01\.jpg$/);
    expect(copies[1][1]).toMatch(/page_02\.png$/);

    const md = split.split.mock.calls[0][0].markdown;
    expect(md.indexOf('<!-- page 1 -->')).toBeLessThan(md.indexOf('<!-- page 2 -->'));
    expect(md).toContain('第一页');
    expect(md).toContain('第二页');
  });

  it('超过 6 张 → 400 / code 1001，不查库', async () => {
    const files = { findByIdAndOwner: vi.fn(), create: vi.fn() };
    const { svc } = makeService({ files });
    const err = await expectHttpError(
      svc.recognize({ fileIds: ['1', '2', '3', '4', '5', '6', '7'] }, 1),
      400,
      1001,
    );
    expect(err.getResponse()).toMatchObject({ message: '最多 6 张题图' });
    expect(files.findByIdAndOwner).not.toHaveBeenCalled();
  });

  it('文件不存在或不属于该学生 → 400 / code 1001', async () => {
    const files = { findByIdAndOwner: vi.fn().mockResolvedValue(null), create: vi.fn() };
    const { svc } = makeService({ files });
    const err = await expectHttpError(svc.recognize({ fileIds: ['1'] }, 1), 400, 1001);
    expect(err.getResponse()).toMatchObject({ message: '文件不存在或无权访问' });
    expect(fsMock.copyFile).not.toHaveBeenCalled();
  });

  it('图片格式不支持 → 400 / code 1001', async () => {
    const files = {
      findByIdAndOwner: vi.fn().mockResolvedValue({ ...JPEG_ROW, mime_type: 'image/gif' }),
      create: vi.fn(),
    };
    const { svc } = makeService({ files });
    const err = await expectHttpError(svc.recognize({ fileIds: ['1'] }, 1), 400, 1001);
    expect(err.getResponse()).toMatchObject({ message: '图片格式不支持' });
  });

  it('单张超过 5MB → 400 / code 1001', async () => {
    const files = {
      findByIdAndOwner: vi
        .fn()
        .mockResolvedValue({ ...JPEG_ROW, size_bytes: 5 * 1024 * 1024 + 1 }),
      create: vi.fn(),
    };
    const { svc } = makeService({ files });
    const err = await expectHttpError(svc.recognize({ fileIds: ['1'] }, 1), 400, 1001);
    expect(err.getResponse()).toMatchObject({ message: '图片过大（最大 5MB）' });
  });

  it('MinerU 失败 → 502 / code 5501，且临时目录仍被清理', async () => {
    const mineru = { run: vi.fn().mockRejectedValue(new Error('mineru boom')) };
    const split = { split: vi.fn() };
    const { svc } = makeService({ mineru, split });
    const err = await expectHttpError(svc.recognize({ fileIds: ['1'] }, 1), 502, 5501);
    expect(err.getResponse()).toMatchObject({
      message: '图片解析失败，请重试或手动输入题目',
    });
    expect(split.split).not.toHaveBeenCalled();
    expect(fsMock.rm).toHaveBeenCalledTimes(1);
  });

  it('MinerU 没有产出 Markdown → 502 / code 5501', async () => {
    fsMock.readdir.mockResolvedValue([]);
    const split = { split: vi.fn() };
    const { svc } = makeService({ split });
    await expectHttpError(svc.recognize({ fileIds: ['1'] }, 1), 502, 5501);
  });

  it('切题失败 → 502 / code 5502，且临时目录仍被清理', async () => {
    const split = { split: vi.fn().mockRejectedValue(new Error('split boom')) };
    const { svc } = makeService({ split });
    const err = await expectHttpError(svc.recognize({ fileIds: ['1'] }, 1), 502, 5502);
    expect(err.getResponse()).toMatchObject({
      message: '题目切分失败，请重试或手动输入题目',
    });
    expect(fsMock.rm).toHaveBeenCalledTimes(1);
  });

  it('切题结果为空 → candidates: []', async () => {
    const split = { split: vi.fn().mockResolvedValue([]) };
    const { svc } = makeService({ split });
    const r = await svc.recognize({ fileIds: ['1'] }, 1);
    expect(r).toEqual({ candidates: [], figures: [] });
  });

  it('没有配图时 uploaded_files 不写行，figureUrls 为空', async () => {
    fsMock.readdir.mockImplementation(async (dir: string) => {
      if (dir.endsWith('images')) throw new Error('ENOENT');
      return ['page_01.md'];
    });
    fsMock.readFile.mockResolvedValue('纯文字，无图');
    const split = {
      split: vi.fn().mockResolvedValue([
        {
          no: '1',
          content: '纯文字，无图',
          figureRefs: [],
          suggestedSubject: null,
          confidence: 0.5,
          selectedHint: false,
        },
      ]),
    };
    const files = {
      findByIdAndOwner: vi.fn().mockResolvedValue(JPEG_ROW),
      create: vi.fn().mockResolvedValue(1),
    };
    const { svc } = makeService({ files, split });

    const r = await svc.recognize({ fileIds: ['1'] }, 1);

    expect(files.create).not.toHaveBeenCalled();
    expect(r.candidates[0].figureUrls).toEqual([]);
    expect(r.figures).toEqual([]);
  });

  it('uploaded_files 写入失败不阻断识别', async () => {
    const files = {
      findByIdAndOwner: vi.fn().mockResolvedValue(JPEG_ROW),
      create: vi.fn().mockRejectedValue(new Error('db down')),
    };
    const split = {
      split: vi.fn().mockResolvedValue([
        {
          no: '1',
          content: '已知 ![a](images/a.jpg)',
          figureRefs: ['images/a.jpg'],
          suggestedSubject: null,
          confidence: 0.5,
          selectedHint: false,
        },
      ]),
    };
    const { svc } = makeService({ files, split });

    const r = await svc.recognize({ fileIds: ['1'] }, 1);

    expect(r.candidates[0].figureUrls).toHaveLength(1);
  });
});
