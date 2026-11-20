import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import { ContentAuditRepository, type AuditActor } from '../../database/repositories/content-audit.repo.js';
import { getUploadDir } from '../files/files.service.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 教研图片 URL：只认 /uploads/research/<uuid><ext>（spec §8.1/§8.5 铁律 1）。
 * 扩展名可选：extension-less 上传也要能清理；`[0-9a-f-]+` 不含点，路径穿越仍被拒。
 */
const RESEARCH_URL_RE = /^\/uploads\/research\/[0-9a-f-]+(?:\.[a-zA-Z0-9]+)?$/;

export interface ResearchImageCleanupResult {
  deleted: number;
  skipped: number;
}

export interface ResearchImageGcResult extends ResearchImageCleanupResult {
  scanned: number;
  failed: number;
}

/**
 * 教研图片清理服务（spec §8.4/§8.5）。
 *
 * 铁律：只清 source='research' 且路径合法的图；删前全局扫描引用（questions 五列 +
 * 学生作答三表 + extract_tasks）；DB 行先删，磁盘文件后删且失败只记日志；每次清理写审计。
 * actor 由调用方逐次传入，不存 service 字段，避免并发串号。
 *
 * 失败隔离：整批 URL 预校验（非法直接 400，无任何删除）；单条的扫描/删除错误吞掉并记
 * skipped，绝不抛到删卷等 post-commit 调用方；审计失败只记日志，不影响已完成的删除计数。
 */
@Injectable()
export class ResearchImagesService {
  private readonly logger = new Logger(ResearchImagesService.name);
  private readonly uploadDir = getUploadDir();

  constructor(
    @Inject('DATABASE_POOL') private readonly pool: Pool,
    private readonly files: UploadedFilesRepository,
    private readonly audit: ContentAuditRepository,
  ) {}

  async cleanupUnreferenced(
    urls: string[],
    actor: AuditActor,
  ): Promise<ResearchImageCleanupResult> {
    const unique = [...new Set(urls)];
    // 先校验整批，避免 [valid, invalid] 删掉 valid 之后才 400。
    for (const url of unique) {
      if (!RESEARCH_URL_RE.test(url)) {
        throw new BadRequestException({ code: 1001, message: `非法图片 URL：${url}` });
      }
    }

    let deleted = 0;
    let skipped = 0;
    for (const url of unique) {
      let deletedRow: { id: number } | null = null;
      try {
        // findByUrl 是 unscoped 的（Task 3 deferred-minor）：来源校验必须由调用方做。
        const row = await this.files.findByUrl(url);
        if (!row || row.source !== 'research') {
          skipped++;
          continue;
        }

        // 铁律 2：全局引用检查（questions 五列 + 学生作答三表）。
        const like = `%${url}%`;
        const [q] = await this.pool.execute<RowDataPacket[]>(
          `SELECT COUNT(*) AS cnt FROM questions
            WHERE content LIKE ? OR options LIKE ? OR answer LIKE ? OR explanation LIKE ? OR approach LIKE ?`,
          [like, like, like, like, like],
        );
        const [a] = await this.pool.execute<RowDataPacket[]>(
          `SELECT (SELECT COUNT(*) FROM exam_answers WHERE answer_text LIKE ?)
                 + (SELECT COUNT(*) FROM answers WHERE answer_text LIKE ?)
                 + (SELECT COUNT(*) FROM special_answer_records WHERE answer_text LIKE ?) AS cnt`,
          [like, like, like],
        );
        // 铁律 3：extract_tasks FK RESTRICT，硬删会报错。
        const [t] = await this.pool.execute<RowDataPacket[]>(
          'SELECT COUNT(*) AS cnt FROM extract_tasks WHERE file_id = ?', [row.id],
        );
        if (Number(q[0].cnt) > 0 || Number(a[0].cnt) > 0 || Number(t[0].cnt) > 0) {
          skipped++;
          continue;
        }

        // 铁律 4：DB 行先删，commit 后删磁盘；失败只记日志。
        await this.files.delete(row.id);
        const abs = path.resolve(this.uploadDir, url.replace(/^\/uploads\//, ''));
        if (!abs.startsWith(path.resolve(this.uploadDir) + path.sep)) {
          this.logger.warn(`非法图片路径，跳过删文件：${url}`);
        } else {
          await fs.unlink(abs).catch((e) => this.logger.warn(`删图失败 ${url}: ${e}`));
        }
        deletedRow = row;
      } catch (e) {
        this.logger.warn(`清理失败 ${url}: ${e}`);
        skipped++;
      }

      // 铁律 5：审计独立包裹——DB 已删，审计失败只记日志，不回滚也不误记为 skipped。
      if (deletedRow) {
        deleted++;
        try {
          await this.audit.append({
            actorId: actor.sub,
            actorRole: actor.role,
            actorName: actor.name ?? null,
            action: 'image.delete',
            targetType: 'image',
            targetId: deletedRow.id,
          });
        } catch (e) {
          this.logger.warn(`审计写入失败 ${url}（图已删除）: ${e}`);
        }
      }
    }
    return { deleted, skipped };
  }

  /** GC 兜底：扫 >N 小时的 research 孤儿行，逐条走同一套清理铁律。 */
  async gc(hours: number, actor: AuditActor): Promise<ResearchImageGcResult> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, url FROM uploaded_files
        WHERE source = 'research' AND created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
      [hours],
    );
    const result: ResearchImageGcResult = { scanned: 0, deleted: 0, skipped: 0, failed: 0 };
    for (const row of rows) {
      result.scanned++;
      try {
        const one = await this.cleanupUnreferenced([String(row.url)], actor);
        result.deleted += one.deleted;
        result.skipped += one.skipped;
      } catch (e) {
        this.logger.warn(`GC 清理失败 ${String(row.url)}: ${e}`);
        result.failed++;
      }
    }
    return result;
  }
}
