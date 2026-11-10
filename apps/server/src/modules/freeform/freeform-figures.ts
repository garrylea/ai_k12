import * as path from 'node:path';

/** MinerU Markdown 里的题图引用形如 `![alt](images/a.jpg)`，只认 `images/` 前缀。 */
const IMG_RE = /!\[([^\]]*)\]\((images\/[^)\s]+)\)/g;

/**
 * 把 MinerU 输出里的相对配图引用改写成公开 URL。
 *
 * 只重写 `images/` 前缀：外链（`https://…`）与其它相对路径保持原样，
 * 避免把用户原文里的图片地址误指向本服务的静态目录。
 *
 * `mapName` 用于落盘时的重命名（多页各自的 `images/` 会有同名文件，
 * 服务端加 `fig-<page>-` 前缀后，Markdown 引用必须指向重命名后的文件）。
 * 默认原样保留文件名。
 */
export function rewriteFigureRefs(
  markdown: string,
  publicBase: string,
  mapName: (name: string) => string = (name) => name,
): { markdown: string; urls: string[] } {
  const urls: string[] = [];
  const out = markdown.replace(IMG_RE, (_m, alt: string, rel: string) => {
    const name = mapName(path.posix.basename(rel));
    const url = `${publicBase}/${name}`;
    urls.push(url);
    return `![${alt}](${url})`;
  });
  return { markdown: out, urls: [...new Set(urls)] };
}

/** 按出现顺序列出 `images/` 相对引用（含重复）。 */
export function figureRefs(markdown: string): string[] {
  return [...markdown.matchAll(IMG_RE)].map((m) => m[2]);
}
