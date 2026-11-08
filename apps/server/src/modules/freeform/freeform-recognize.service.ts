import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import type { UploadedFileRow } from '../../database/repositories/types.js';
import { FreeformSplitCapability } from '../../ai-core/capabilities/freeform-split.capability.js';
import { MineruRunner, mineruLimiter } from './mineru-runner.js';
import { rewriteFigureRefs } from './freeform-figures.js';

export interface FreeformRecognizeResult {
  candidates: Array<{
    id: string;
    no: string;
    content: string;
    figureUrls: string[];
    suggestedSubject: 'math' | 'physics' | 'chemistry' | null;
    confidence: number;
  }>;
  figures: Array<{ url: string; name: string; page: number }>;
}

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
/**
 * 切题模型上下文上限：超过就不是「截断后还能切对」的量级了。
 * 超长时不截断，改走 `preferFallback`（千问）送全文——截断会静默丢掉尾部题目。
 */
const MAX_MARKDOWN = 24000;

const MINERU_FAILED = { code: 5501, message: '图片解析失败，请重试或手动输入题目' } as const;

/**
 * 自由输入做题第一步：题图/文字 → MinerU Markdown → 候选题。
 *
 * 纯文字完全短路（不碰磁盘、不调模型）。图片流程把题图按 `fileIds` 顺序复制成
 * `page_01.jpg` 再交给 MinerU，配图落到 `UPLOAD_DIR/freeform/<jobId>/` 并登记
 * `uploaded_files`（source=freeform_figure），这样后续判题/重做能按 URL 找到图。
 * 临时目录无论如何都在 finally 清掉。
 */
@Injectable()
export class FreeformRecognizeService {
  private readonly logger = new Logger(FreeformRecognizeService.name);
  private readonly uploadDir = process.env.UPLOAD_DIR ?? './uploads';
  private readonly tmpDir = os.tmpdir();

  constructor(
    private readonly mineru: MineruRunner,
    private readonly split: FreeformSplitCapability,
    private readonly files: UploadedFilesRepository,
  ) {}

  async recognize(
    // 只传文字时前端不带 fileIds，按空数组处理（纯文字短路）。
    input: { text?: string; fileIds?: string[] },
    studentId: number,
  ): Promise<FreeformRecognizeResult> {
    const text = (input.text ?? '').trim();
    const fileIds = input.fileIds ?? [];
    if (text.length > 20000) throw new BadRequestException({ code: 1001, message: '题目文字过长' });
    if (fileIds.length > MAX_IMAGES) {
      throw new BadRequestException({ code: 1001, message: '最多 6 张题图' });
    }
    if (fileIds.length === 0) {
      if (!text) throw new BadRequestException({ code: 1001, message: '请上传题目图片或输入题目文字' });
      return {
        candidates: [
          {
            id: 'c1',
            no: '1',
            content: text,
            figureUrls: [],
            suggestedSubject: null,
            confidence: 1,
          },
        ],
        figures: [],
      };
    }

    const rows: UploadedFileRow[] = [];
    for (const id of fileIds) {
      const row = await this.files.findByIdAndOwner(Number(id), studentId);
      if (!row) throw new BadRequestException({ code: 1001, message: '文件不存在或无权访问' });
      if (!ALLOWED.has(row.mime_type)) {
        throw new BadRequestException({ code: 1001, message: '图片格式不支持' });
      }
      if (row.size_bytes > MAX_IMAGE_BYTES) {
        throw new BadRequestException({ code: 1001, message: '图片过大（最大 5MB）' });
      }
      rows.push(row);
    }

    const jobId = randomUUID();
    const work = path.join(this.tmpDir, `freeform-recognize-${jobId}`);
    const out = path.join(work, 'out');
    const publicBase = `/uploads/freeform/${jobId}`;
    const destDir = path.join(this.uploadDir, 'freeform', jobId);
    try {
      await fs.mkdir(out, { recursive: true });
      await fs.mkdir(destDir, { recursive: true });

      // 按 fileIds 顺序命名：MinerU 的多页结果依赖文件名顺序。
      const pages: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const ext =
          rows[i].mime_type === 'image/png'
            ? '.png'
            : rows[i].mime_type === 'image/webp'
              ? '.webp'
              : '.jpg';
        const src = path.join(this.uploadDir, rows[i].url.replace(/^\/uploads\//, ''));
        const dst = path.join(work, `page_${String(i + 1).padStart(2, '0')}${ext}`);
        await fs.copyFile(src, dst);
        pages.push(dst);
      }

      try {
        await mineruLimiter.run(() => this.mineru.run(pages, out));
      } catch {
        throw new HttpException(MINERU_FAILED, 502);
      }

      // 每张输入图都必须有对应的 Markdown：少一页就是解析残缺，不能拿半套结果去切题。
      const pageMarkdowns = await this.findPageMarkdowns(out, rows.length);

      // 逐页落配图 + 重写引用，页间留注释锚点（切题模型据此判断跨页题）。
      const figures: Array<{ url: string; name: string; page: number }> = [];
      // 扁平输出是共享 `out/images/`：同一张图被多页引用时只落一份，别按页重复复制。
      const copiedSources = new Map<string, string>();
      const parts: string[] = [];
      for (let i = 0; i < pageMarkdowns.length; i++) {
        const pageNo = i + 1;
        const nameMap = await this.copyPageFigures(
          pageMarkdowns[i],
          pageNo,
          destDir,
          publicBase,
          studentId,
          figures,
          copiedSources,
        );
        const md = await fs.readFile(pageMarkdowns[i], 'utf-8');
        // 多页各自的 images/ 里可能同名，落盘统一加 fig-<page>- 前缀，引用同步改写。
        const rewritten = rewriteFigureRefs(
          md,
          publicBase,
          (name) => nameMap.get(name) ?? `fig-${pageNo}-${name}`,
        );
        parts.push(`<!-- page ${pageNo} -->\n${rewritten.markdown}`);
      }
      const markdown = parts.join('\n\n');
      const preferFallback = markdown.length > MAX_MARKDOWN;

      let candidates: Awaited<ReturnType<FreeformSplitCapability['split']>> = [];
      try {
        candidates = await this.split.split({ markdown, textHint: text, preferFallback });
      } catch {
        throw new HttpException(
          { code: 5502, message: '题目切分失败，请重试或手动输入题目' },
          502,
        );
      }
      if (candidates.length === 0) return { candidates: [], figures: [] };

      // figureUrls 必须是本次真实落盘的子集（模型可能幻觉出不存在的图）。
      const allFigures = new Set(figures.map((f) => f.url));
      return {
        candidates: candidates.map((c, i) => ({
          id: `c${i + 1}`,
          no: c.no || String(i + 1),
          content: c.content,
          figureUrls: c.figureRefs
            .map((r) => `${publicBase}/${path.posix.basename(r)}`)
            .filter((u) => allFigures.has(u)),
          suggestedSubject: c.suggestedSubject,
          confidence: c.confidence,
        })),
        figures,
      };
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 按输入页数找齐 Markdown：优先 `out/<stem>.md`（MinerU 扁平输出），
   * 找不到再递归扫 `out/` 取文件名以 stem 开头的第一个（新版本按页建子目录）。
   * 少一页就抛 5501——不能让缺页的结果静默返回。
   */
  private async findPageMarkdowns(outDir: string, expected: number): Promise<string[]> {
    const all = await this.collectMarkdowns(outDir);
    const picked: string[] = [];
    for (let i = 0; i < expected; i++) {
      const stem = `page_${String(i + 1).padStart(2, '0')}`;
      const direct = path.join(outDir, `${stem}.md`);
      const found = all.includes(direct)
        ? direct
        : all.find((p) => path.basename(p).startsWith(stem));
      if (!found) throw new HttpException(MINERU_FAILED, 502);
      picked.push(found);
    }
    return picked;
  }

  /** 递归收集 `out/` 下所有 `.md`（相对路径排序保证「第一个匹配」稳定）。 */
  private async collectMarkdowns(root: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.md')) found.push(full);
      }
    };
    await walk(root);
    return found.sort();
  }

  /**
   * 把某一页 Markdown 的同级 `images/` 复制到公开目录并登记。
   *
   * 文件名加页前缀，多页同名图不会互相覆盖；`copiedSources` 以源路径去重，
   * 扁平输出的共享 `images/` 不会被每页重复复制。
   * 登记失败（含取不到大小）不阻断识别：图已经可访问，缺一行 uploaded_files 比丢掉整道题轻。
   *
   * @returns 该页 Markdown 里原始文件名 → 落盘文件名
   */
  private async copyPageFigures(
    markdownPath: string,
    pageNo: number,
    destDir: string,
    publicBase: string,
    studentId: number,
    figures: Array<{ url: string; name: string; page: number }>,
    copiedSources: Map<string, string>,
  ): Promise<Map<string, string>> {
    const imgDir = path.join(path.dirname(markdownPath), 'images');
    let names: string[] = [];
    try {
      names = (await fs.readdir(imgDir)).sort();
    } catch {
      return new Map(); /* MinerU 可能没有输出配图 */
    }
    const byName = new Map<string, string>();
    for (const raw of names) {
      const name = path.posix.basename(raw);
      const src = path.join(imgDir, raw);
      let copyName = copiedSources.get(src);
      if (!copyName) {
        copyName = `fig-${pageNo}-${name}`;
        copiedSources.set(src, copyName);
        const dst = path.join(destDir, copyName);
        await fs.copyFile(src, dst);
        const url = `${publicBase}/${copyName}`;
        figures.push({ url, name: copyName, page: pageNo });

        let size: number;
        try {
          size = (await fs.stat(dst)).size;
        } catch {
          // 量不到大小就写 NULL 语义行不通（size_bytes 非空），宁可不登记也不写 0。
          this.logger.warn(`配图落盘后取不到大小，跳过 uploaded_files 登记：${copyName}`);
          byName.set(name, copyName);
          continue;
        }
        // 登记失败不阻断识别：图仍可通过 url 访问。
        await this.files
          .create({
            uploader_id: studentId,
            uploader_type: 'student',
            url,
            mime_type: 'image/jpeg',
            size_bytes: size,
            source: 'freeform_figure',
          })
          .catch(() => {});
      }
      byName.set(name, copyName);
    }
    return byName;
  }
}
