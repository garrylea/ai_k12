import { createHash } from 'node:crypto';

export function normalizeForHash(content: string): string {
  return content
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''（）【】]/g, '')
    .replace(/[,!?;:"'()\[\]]/g, '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

export function computeContentHash(content: string): string {
  return createHash('sha256').update(normalizeForHash(content)).digest('hex');
}
