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

/** 剥掉 Markdown 图片与 HTML 注释（含 <!-- page N --> 页码标记；spec §4.2）。
 *  AI 生成的 freeform 题带图时，同一道题换图片 URL 也应命中同一条记录。 */
export function stripMarkdownImages(content: string): string {
  return content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function computeFreeformContentHash(content: string): string {
  const stripped = stripMarkdownImages(content);
  // 纯图片题（正文只有图片）剥完是空串：回退用原文，否则所有纯图题会撞同一个
  // sha256('') 而被去重成同一道题。
  return computeContentHash(stripped || content);
}

// 更宽松的归一化：在 normalizeForHash 基础上再去掉标点/符号。用于「同一道题
// 只是文字或格式微调」的兜底匹配（同一道题连标点都可能不完全一致）。
export const PREFIX_STRIP = /[\s,，.。!！?？;；:：、·'"“”‘’`()（）\[\]【】{}<>《》「」『』〈〉…～~〜\-—_/\\|]/g;

export function normalizeForPrefix(content: string): string {
  return content.normalize('NFKC').toLowerCase().replace(PREFIX_STRIP, '');
}

/** 题目前缀指纹：归一化后的前 N 个字（默认 20），作为 hash 未命中时的兜底键。 */
export function contentPrefix(content: string, len = 20): string {
  return normalizeForPrefix(content).slice(0, len);
}
