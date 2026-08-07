import { createHash } from 'node:crypto';

/** 对齐 tools/data-refinery/src/db_loader.py::normalize_content：
 *  NFKC 全半角归一 + 去所有空白 + 转小写（不删标点）。
 *  Node 的 String.prototype.normalize('NFKC') 等价于 Python unicodedata.normalize('NFKC', s)，
 *  对同一字符串产出相同码点序列，跨语言哈希一致。 */
export function normalizeForHash(content: string): string {
  return content
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function computeContentHash(content: string): string {
  return createHash('sha256').update(normalizeForHash(content)).digest('hex');
}
