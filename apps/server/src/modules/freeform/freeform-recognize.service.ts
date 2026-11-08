import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import type { UploadedFileRow } from '../../database/repositories/types.js';
import { FreeformSplitCapability } from '../../ai-core/capabilities/freeform-split.capability.js';
import { MineruRunner, mineruLimiter } from './mineru-runner.js';
import { rewriteFigureRefs, figureRefs } from './freeform-figures.js';

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
/** 切题模型上下文上限：超长 Markdown 截断，避免单次请求堆爆 token。 */
const MAX_MARKDOWN = 24000;

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
        throw new HttpException(
          { code: 5501, message: '图片解析失败，请重试或手动输入题目' },
          502,
        );
      }

      const entries = (await fs.readdir(out)).filter((f: string) => f.endsWith('.md')).sort();
      if (entries.length === 0) {
        throw new HttpException(
          { code: 5501, message: '图片解析失败，请重试或手动输入题目' },
          502,
        );
      }

      // 配图：复制到公开目录 + 登记 uploaded_files（登记失败不阻断识别，图仍可访问）。
      const imgDir = path.join(out, 'images');
      let imgNames: string[] = [];
      try {
        imgNames = await fs.readdir(imgDir);
      } catch {
        /* MinerU 可能没有输出配图 */
      }
      for (const name of imgNames) {
        const dst = path.join(destDir, name);
        await fs.copyFile(path.join(imgDir, name), dst);
        const st = await fs.stat(dst).catch(() => ({ size: 0 }));
        await this.files
          .create({
            uploader_id: studentId,
            uploader_type: 'student',
            url: `${publicBase}/${path.posix.basename(name)}`,
            mime_type: 'image/jpeg',
            size_bytes: st.size,
            source: 'freeform_figure',
          })
          .catch(() => {});
      }

      // 逐页拼接，页间留注释锚点，切题模型据此判断跨页题。
      const parts: string[] = [];
      for (let i = 0; i < entries.length; i++) {
        const md = await fs.readFile(path.join(out, entries[i]), 'utf-8');
        const rewritten = rewriteFigureRefs(md, publicBase);
        parts.push(`<!-- page ${i + 1} -->\n${rewritten.markdown}`);
      }
      const markdown = parts.join('\n\n');
      const splitInput = markdown.length > MAX_MARKDOWN ? markdown.slice(0, MAX_MARKDOWN) : markdown;

      let candidates: Awaited<ReturnType<FreeformSplitCapability['split']>> = [];
      try {
        candidates = await this.split.split({ markdown: splitInput, textHint: text });
      } catch {
        throw new HttpException(
          { code: 5502, message: '题目切分失败，请重试或手动输入题目' },
          502,
        );
      }
      if (candidates.length === 0) return { candidates: [], figures: [] };

      const allFigures = new Set<string>();
      for (const name of imgNames) allFigures.add(`${publicBase}/${path.posix.basename(name)}`);

      return {
        candidates: candidates.map((c, i) => {
          const refs = c.figureRefs
            .map((r) => `${publicBase}/${path.posix.basename(r)}`)
            .filter((u) => allFigures.has(u));
          return {
            id: `c${i + 1}`,
            no: c.no || String(i + 1),
            content: c.content,
            // figureRefs 只留真实落盘的图；缺失时回退到正文里的图片引用。
            figureUrls: refs.length
              ? refs
              : figureRefs(c.content).map((r) => `${publicBase}/${path.posix.basename(r)}`),
            suggestedSubject: c.suggestedSubject,
            confidence: c.confidence,
          };
        }),
        figures: [...allFigures].map((url) => ({
          url,
          name: path.posix.basename(url),
          page: 1,
        })),
      };
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
}
