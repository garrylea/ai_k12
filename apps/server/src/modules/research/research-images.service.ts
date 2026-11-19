import { Injectable } from '@nestjs/common';

/**
 * 教研图片清理服务（Task 6 空壳，签名与 Task 7 实装完全一致）。
 * Task 7 将填充：按 URL 反查 uploaded_files、全局引用扫描、无引用才删 DB 行 + 磁盘文件。
 * 磁盘删除在 DB commit 之后，失败只记日志。
 */
@Injectable()
export class ResearchImagesService {
  async cleanupUnreferenced(
    _urls: string[],
    _actor: { sub: number; role: string; name?: string | null },
  ): Promise<{ deleted: number; skipped: number }> {
    return { deleted: 0, skipped: 0 };
  }
}
