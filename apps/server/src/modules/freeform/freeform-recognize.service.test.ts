import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * 内存 fs 替身：识别服务要读 MinerU 输出、复制题图、落盘配图。
 * 全部走 mock，测试不碰真实磁盘（也不会在 CI 上留下 /tmp 垃圾）。
 *
 * 目录树按「虚拟路径」登记：临时目录名带随机 uuid，`norm()` 把
 * `freeform-recognize-<uuid>` 折叠成 `<work>`，用例只描述 MinerU 的输出结构。
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

import { HttpException, Logger } from '@nestjs/common';
import { FreeformRecognizeService } from './freeform-recognize.service.js';

type Entry = { name: string; dir: boolean };

const WORK_RE = /^.*freeform-recognize-[0-9a-f-]{36}/;
const norm = (p: string) => p.replace(WORK_RE, '<work>');

const dirs = new Map<string, Entry[]>();
const contents = new Map<string, string>();

function setDir(p: string, entries: Array<[string, 'file' | 'dir']>): void {
  dirs.set(p, entries.map(([name, kind]) => ({ name, dir: kind === 'dir' })));
}

function setFile(p: string, content: string): void {
  contents.set(p, content);
}

/** 扁平输出：`out/page_0N.md` + 共享 `out/images/`。 */
function flatLayout(pages: Array<{ stem: string; md: string; images?: string[] }>): void {
  setDir(
    '<work>/out',
    [...pages.map((p) => [p.stem, 'file'] as [string, 'file']), ['images', 'dir']],
  );
  setDir(
    '<work>/out/images',
    pages.flatMap((p) => (p.images ?? []).map((n) => [n, 'file'] as [string, 'file'])),
  );
  for (const p of pages) setFile(`<work>/out/${p.stem}`, p.md);
}

/** 嵌套输出：`out/page_01/page_01.md` + `out/page_01/images/`。 */
function nestedLayout(pages: Array<{ dir: string; md: string; images: string[] }>): void {
  setDir(
    '<work>/out',
    pages.map((p) => [p.dir, 'dir'] as [string, 'dir']),
  );
  for (const p of pages) {
    setDir(`<work>/out/${p.dir}`, [
      [p.md, 'file'],
      ['images', 'dir'],
    ]);
    setDir(
      `<work>/out/${p.dir}/images`,
      p.images.map((n) => [n, 'file'] as [string, 'file']),
    );
  }
}

const JPEG_ROW = { id: 1, url: '/uploads/a.jpg', mime_type: 'image/jpeg', size_bytes: 10 };

beforeAll(() => {
  process.env.UPLOAD_DIR = '/tmp/u';
});

beforeEach(() => {
  process.env.UPLOAD_DIR = '/tmp/u';
  for (const fn of Object.values(fsMock)) fn.mockReset();
  dirs.clear();
  contents.clear();
  flatLayout([{ stem: 'page_01.md', md: '已知 ![a](images/a.jpg)', images: ['a.jpg'] }]);

  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.copyFile.mockResolvedValue(undefined);
  fsMock.rm.mockResolvedValue(undefined);
  fsMock.stat.mockResolvedValue({ size: 10 });

  fsMock.readdir.mockImplementation(
    async (dir: string, opts?: { withFileTypes?: boolean }) => {
      const entries = dirs.get(norm(dir));
      if (!entries) throw new Error(`ENOENT: ${dir}`);
      if (opts?.withFileTypes) {
        return entries.map((e) => ({
          name: e.name,
          isDirectory: () => e.dir,
          isFile: () => !e.dir,
        }));
      }
      return entries.filter((e) => !e.dir).map((e) => e.name);
    },
  );
  fsMock.readFile.mockImplementation(async (p: string) => {
    const key = norm(p);
    const content = contents.get(key);
    if (content === undefined) throw new Error(`ENOENT: ${p}`);
    return content;
  });
});

afterEach(() => {
  delete process.env.UPLOAD_DIR;
});

function makeService(
  overrides: {
    mineru?: any;
    split?: any;
    files?: any;
    mineruConfig?: any;
  } = {},
) {
  const mineru = overrides.mineru ?? { run: vi.fn().mockResolvedValue(undefined) };
  const split = overrides.split ?? { split: vi.fn().mockResolvedValue([]) };
  const files =
    overrides.files ??
    {
      findByIdAndOwner: vi.fn().mockResolvedValue(JPEG_ROW),
      create: vi.fn().mockResolvedValue(1),
    };
  const mineruConfig =
    overrides.mineruConfig ??
    {
      get: vi.fn().mockResolvedValue({
        enabled: true,
        bin: 'mineru-open-api',
        token: 'sk-test',
        timeoutMs: 90000,
        concurrency: 2,
        tokenSource: 'db',
      }),
    };
  const svc = new FreeformRecognizeService(mineru, split, files, mineruConfig);
  return { svc, mineru, split, files, mineruConfig };
}

/** 断言抛出 HttpException，并核对 HTTP 状态码与业务 code。 */
async function expectHttpError(
  p: Promise<unknown>,
  status: number,
  code: number,
): Promise<HttpException> {
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

/** 切题 mock：像真模型一样，从重写后的 Markdown 里回抄配图 URL 作为 figureRefs。 */
function splitEchoingFigures(content = '已知 ![a](images/a.jpg)') {
  return {
    split: vi.fn(
      async (req: { markdown: string; textHint?: string; preferFallback?: boolean }) => {
        const refs = [...req.markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
        return [
          {
            no: '5',
            content,
            figureRefs: refs,
            suggestedSubject: 'math',
            confidence: 0.9,
            selectedHint: false,
          },
        ];
      },
    ),
  };
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
  it('校验+按顺序复制+调 MinerU+重写配图+返回候选（扁平布局）', async () => {
    const mineru = { run: vi.fn().mockResolvedValue(undefined) };
    const split = splitEchoingFigures();
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

    // 配图：复制到公开目录（带页前缀）并登记 uploaded_files
    const destCopy = fsMock.copyFile.mock.calls.find(([src]: string[]) =>
      src.endsWith('/out/images/a.jpg'),
    );
    expect(destCopy).toBeDefined();
    expect(destCopy![1]).toMatch(/^\/tmp\/u\/freeform\/[0-9a-f-]{36}\/fig-1-a\.jpg$/);
    expect(files.create).toHaveBeenCalledWith({
      uploader_id: 1,
      uploader_type: 'student',
      url: expect.stringMatching(/^\/uploads\/freeform\/[0-9a-f-]{36}\/fig-1-a\.jpg$/),
      mime_type: 'image/jpeg',
      size_bytes: 10,
      source: 'freeform_figure',
    });

    // 切题：拿到的是重写后的 Markdown（带页码锚点、指向落盘文件名）
    const splitArg = split.split.mock.calls[0][0];
    expect(splitArg.textHint).toBe('第5题');
    expect(splitArg.preferFallback).toBe(false);
    expect(splitArg.markdown).toContain('<!-- page 1 -->');
    expect(splitArg.markdown).toMatch(
      /!\[a\]\(\/uploads\/freeform\/[0-9a-f-]{36}\/fig-1-a\.jpg\)/,
    );

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
      { url: files.create.mock.calls[0][0].url, name: 'fig-1-a.jpg', page: 1 },
    ]);

    // 临时目录在 finally 清掉
    expect(fsMock.rm).toHaveBeenCalledWith(expect.stringMatching(/freeform-recognize-[^/]+$/), {
      recursive: true,
      force: true,
    });
  });

  it('多张图按 fileIds 顺序命名 page_01/page_02；共享 images 只落一份', async () => {
    const ran = { id: 1, url: '/uploads/a.jpg', mime_type: 'image/jpeg', size_bytes: 10 };
    const png = { id: 2, url: '/uploads/b.png', mime_type: 'image/png', size_bytes: 10 };
    const files = {
      findByIdAndOwner: vi.fn(async (id: number) => (id === 1 ? ran : png)),
      create: vi.fn().mockResolvedValue(1),
    };
    // 扁平布局：两页共用 out/images，第二页重复引用第一页的图。
    flatLayout([
      { stem: 'page_01.md', md: '第一页 ![a](images/a.jpg)', images: ['a.jpg', 'b.png'] },
      { stem: 'page_02.md', md: '第二页 ![a](images/a.jpg) ![b](images/b.png)' },
    ]);
    const split = { split: vi.fn().mockResolvedValue([]) };
    const { svc } = makeService({ files, split });

    await svc.recognize({ fileIds: ['1', '2'] }, 9);

    const copies = fsMock.copyFile.mock.calls.map(([src, dst]: string[]) => [src, dst]);
    expect(copies[0][1]).toMatch(/page_01\.jpg$/);
    expect(copies[1][1]).toMatch(/page_02\.png$/);

    // a.jpg 只复制一次（fig-1-），b.png 第一次出现在第 1 页的 images 里，归第 1 页。
    const figureCopies = copies.filter(([src]) => String(src).includes('/out/images/'));
    expect(figureCopies).toHaveLength(2);
    expect(figureCopies.map(([, dst]) => dst)).toEqual([
      expect.stringMatching(/fig-1-a\.jpg$/),
      expect.stringMatching(/fig-1-b\.png$/),
    ]);
    expect(files.create).toHaveBeenCalledTimes(2);

    const md = split.split.mock.calls[0][0].markdown;
    expect(md.indexOf('<!-- page 1 -->')).toBeLessThan(md.indexOf('<!-- page 2 -->'));
    expect(md).toContain('第一页');
    expect(md).toContain('第二页');
    expect(md.split('fig-1-a.jpg')).toHaveLength(3); // 两页各引用一次 + 第 1 页自身
    expect(md).toContain('fig-1-b.png');
  });

  it('嵌套布局（out/page_0N/page_0N.md + 各自 images）：同名图按页前缀区分', async () => {
    const png = { id: 2, url: '/uploads/b.png', mime_type: 'image/png', size_bytes: 10 };
    let looked = 0;
    const files = {
      findByIdAndOwner: vi.fn(async () => {
        looked += 1;
        return looked === 1 ? JPEG_ROW : png;
      }),
      create: vi.fn().mockResolvedValue(1),
    };
    nestedLayout([
      { dir: 'page_01', md: 'page_01.md', images: ['image_0.jpg'] },
      { dir: 'page_02', md: 'page_02.md', images: ['image_0.jpg'] },
    ]);
    // 让每页的 Markdown 都引用自己的 images/image_0.jpg
    setFile('<work>/out/page_01/page_01.md', '第1页 ![图](images/image_0.jpg)');
    setFile('<work>/out/page_02/page_02.md', '第2页 ![图](images/image_0.jpg)');
    const split = { split: vi.fn().mockResolvedValue([]) };
    const { svc } = makeService({ files, split });

    await svc.recognize({ fileIds: ['1', '2'] }, 1);

    const figureCopies = fsMock.copyFile.mock.calls
      .map(([src, dst]: string[]) => [src, dst] as const)
      .filter(([src]) => String(src).includes('/images/'));
    expect(figureCopies).toHaveLength(2);
    expect(figureCopies.map(([, dst]) => dst)).toEqual([
      expect.stringMatching(/fig-1-image_0\.jpg$/),
      expect.stringMatching(/fig-2-image_0\.jpg$/),
    ]);
    // 两次登记是两条不同 URL，不会互相覆盖
    const urls = files.create.mock.calls.map(([row]: Array<{ url: string }>) => row.url);
    expect(new Set(urls).size).toBe(2);

    const md = split.split.mock.calls[0][0].markdown;
    expect(md).toContain('<!-- page 1 -->');
    expect(md).toContain('<!-- page 2 -->');
    expect(md).toMatch(/第1页 !\[图\]\(\/uploads\/freeform\/[0-9a-f-]{36}\/fig-1-image_0\.jpg\)/);
    expect(md).toMatch(/第2页 !\[图\]\(\/uploads\/freeform\/[0-9a-f-]{36}\/fig-2-image_0\.jpg\)/);
  });

  it('缺页（2 张图只产出 page_01.md）→ 502 / code 5501', async () => {
    const png = { id: 2, url: '/uploads/b.png', mime_type: 'image/png', size_bytes: 10 };
    const files = {
      findByIdAndOwner: vi.fn(async (id: number) => (id === 1 ? JPEG_ROW : png)),
      create: vi.fn(),
    };
    flatLayout([{ stem: 'page_01.md', md: '只有第一页', images: [] }]);
    const split = { split: vi.fn() };
    const { svc } = makeService({ files, split });

    const err = await expectHttpError(svc.recognize({ fileIds: ['1', '2'] }, 1), 502, 5501);

    expect(err.getResponse()).toMatchObject({ message: '图片解析失败，请重试或手动输入题目' });
    expect(split.split).not.toHaveBeenCalled();
    // 缺页在落配图之前就报错
    expect(files.create).not.toHaveBeenCalled();
    expect(fsMock.rm).toHaveBeenCalledTimes(1);
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

  it('识图已停用 → 503 / code 5503，不查文件也不碰磁盘', async () => {
    const files = { findByIdAndOwner: vi.fn(), create: vi.fn() };
    const mineruConfig = {
      get: vi.fn().mockResolvedValue({
        enabled: false,
        bin: 'mineru-open-api',
        token: 'sk-test',
        timeoutMs: 90000,
        concurrency: 2,
        tokenSource: 'db',
      }),
    };
    const { svc, mineru } = makeService({ files, mineruConfig });

    const err = await expectHttpError(svc.recognize({ fileIds: ['1'] }, 1), 503, 5503);

    expect(err.getResponse()).toMatchObject({ message: '识图功能未启用，请手动输入题目' });
    expect(files.findByIdAndOwner).not.toHaveBeenCalled();
    expect(mineru.run).not.toHaveBeenCalled();
    expect(fsMock.mkdir).not.toHaveBeenCalled();
  });

  it('未配置 token → 503 / code 5503（与 5501「解析失败」区分开）', async () => {
    const mineruConfig = {
      get: vi.fn().mockResolvedValue({
        enabled: true,
        bin: 'mineru-open-api',
        token: '',
        timeoutMs: 90000,
        concurrency: 2,
        tokenSource: 'none',
      }),
    };
    const { svc, mineru } = makeService({ mineruConfig });

    const err = await expectHttpError(svc.recognize({ fileIds: ['1'] }, 1), 503, 5503);

    expect(err.getResponse()).toMatchObject({
      message: '识图功能未配置，请联系管理员或手动输入题目',
    });
    expect(mineru.run).not.toHaveBeenCalled();
  });

  it('有效配置原样交给 runner（bin/token/超时不再由 runner 读 env）', async () => {
    const mineru = { run: vi.fn().mockResolvedValue(undefined) };
    const mineruConfig = {
      get: vi.fn().mockResolvedValue({
        enabled: true,
        bin: '/opt/mineru/bin/mineru-open-api',
        token: 'sk-db',
        timeoutMs: 45000,
        concurrency: 1,
        tokenSource: 'db',
      }),
    };
    const { svc } = makeService({ mineru, mineruConfig });

    await svc.recognize({ fileIds: ['1'] }, 1);

    expect(mineru.run).toHaveBeenCalledWith(
      [expect.stringMatching(/page_01\.jpg$/)],
      expect.stringMatching(/freeform-recognize-[0-9a-f-]{36}\/out$/),
      expect.objectContaining({
        bin: '/opt/mineru/bin/mineru-open-api',
        token: 'sk-db',
        timeoutMs: 45000,
      }),
    );
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
    setDir('<work>/out', []);
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
    flatLayout([{ stem: 'page_01.md', md: '纯文字，无图' }]);
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
    const { svc } = makeService({ files, split: splitEchoingFigures() });

    const r = await svc.recognize({ fileIds: ['1'] }, 1);

    expect(r.candidates[0].figureUrls).toHaveLength(1);
  });

  it('取不到落盘文件大小 → 不写 size_bytes:0 的假行', async () => {
    fsMock.stat.mockRejectedValue(new Error('stat boom'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const files = {
      findByIdAndOwner: vi.fn().mockResolvedValue(JPEG_ROW),
      create: vi.fn().mockResolvedValue(1),
    };
    const { svc } = makeService({ files, split: splitEchoingFigures() });

    const r = await svc.recognize({ fileIds: ['1'] }, 1);

    expect(files.create).not.toHaveBeenCalled();
    // 图本身仍可访问，候选仍能挂上它
    expect(r.figures).toHaveLength(1);
    expect(r.candidates[0].figureUrls).toEqual([r.figures[0].url]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('模型引用不存在的图会被过滤掉（figureUrls 是本次落盘子集）', async () => {
    const split = {
      split: vi.fn().mockResolvedValue([
        {
          no: '1',
          content: '题干',
          figureRefs: ['images/ghost.jpg'],
          suggestedSubject: null,
          confidence: 0.5,
          selectedHint: false,
        },
      ]),
    };
    const { svc } = makeService({ split });

    const r = await svc.recognize({ fileIds: ['1'] }, 1);

    expect(r.candidates[0].figureUrls).toEqual([]);
    expect(r.figures).toHaveLength(1);
  });

  it('Markdown 超过 24000 字 → 送全文并要求直接走千问（不截断）', async () => {
    const tail = '尾部题：求 y 的值。';
    const long = `${'题'.repeat(25000)}${tail}`;
    flatLayout([{ stem: 'page_01.md', md: long }]);
    const split = { split: vi.fn().mockResolvedValue([]) };
    const { svc } = makeService({ split });

    await svc.recognize({ fileIds: ['1'] }, 1);

    const arg = split.split.mock.calls[0][0];
    expect(arg.preferFallback).toBe(true);
    expect(arg.markdown).toContain(tail);
    expect(arg.markdown.length).toBeGreaterThan(24000);
  });
});
