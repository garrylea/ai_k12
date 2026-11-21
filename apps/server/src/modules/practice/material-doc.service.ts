import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 素材库文章读取：把一个 `questions.material_url`（相对路径，如
 * `materials/chinese/{doc_key}/content.md`）读成 markdown 正文，供判题/解析提示词使用。
 *
 * 边界（安全）：
 * - 只读 assetsDir 内的相对路径——`../` 越界、绝对路径、`http(s)://` / 协议相对 `//` /
 *   `data:` 一律拒绝（后者是为了不从外部 URL 取材料，防 SSRF）。
 * - 读取失败（不存在 / 无权限 / 目录）返回 `null` 并 warn，**永不抛进请求路径**：
 *   判题与解析都是主链路，素材缺失只意味着模型少一段上下文。
 *
 * 缓存：按绝对路径 + mtimeMs 命中（题材库重建后 mtime 变，自动失效）。
 */
@Injectable()
export class MaterialDocService {
  private readonly logger = new Logger(MaterialDocService.name);
  private readonly assetsDir: string;
  private readonly cache = new Map<string, { text: string; mtimeMs: number }>();

  // 刻意不写构造函数参数：带 @Injectable() 的类有接口/union 参数时，
  // design:paramtypes 会写成 Object/String，Nest 找不到 token 会启动失败。
  constructor() {
    this.assetsDir = path.resolve(
      process.env.ASSETS_DIR
        ?? path.resolve(process.cwd(), '../../tools/data-refinery/output/assets'),
    );
  }

  async getText(url: string | null | undefined): Promise<string | null> {
    if (!url || /^(?:https?:)?\/\//.test(url) || url.startsWith('data:')) return null;
    const abs = path.resolve(this.assetsDir, url);
    if (!abs.startsWith(this.assetsDir + path.sep)) {
      this.logger.warn(`material_url 越界，忽略：${url}`);
      return null;
    }
    try {
      const stat = fs.statSync(abs);
      const hit = this.cache.get(abs);
      if (hit && hit.mtimeMs === stat.mtimeMs) return hit.text;
      const text = fs.readFileSync(abs, 'utf-8');
      this.cache.set(abs, { text, mtimeMs: stat.mtimeMs });
      return text;
    } catch (err) {
      this.logger.warn(`material doc 读取失败：${url} (${String(err)})`);
      return null;
    }
  }
}
