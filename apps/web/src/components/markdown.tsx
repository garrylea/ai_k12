// apps/web/src/components/markdown.tsx
//
// 统一的 Markdown + LaTeX + 原生 HTML 渲染配置：所有 ReactMarkdown 使用点
// 都应从这里取 plugins / components，确保——
//   1. 图片显示：DB 题目存的是相对路径（questions/math/.../x.jpg），浏览器按
//      当前页 URL 解析会 404；必须经 resolveAsset 补 /assets/ 前缀走 Vite proxy
//      到后端 useStaticAssets（main.ts: tools/data-refinery/output/assets）。
//      破图自动隐藏（onError display:none）避免占位。
//   2. HTML 语法：数学教材的表格、特殊排版常用原生 <table> 等 HTML 描述而非
//      markdown 语法；rehype-raw 把 HAST 里的 raw 节点解析为真实元素。
//   3. 数学公式：remark-math + rehype-katex 渲染 $...$ / $$...$$。
//   4. GFM 表格/删除线：remark-gfm。
//
// 改 ReactMarkdown 渲染相关 bug 时，先确认调用方用的是这里的导出，不要在各
// 页面再自定义一份 resolveAsset / plugins / img，否则又会漂移。
//
// 顺序：rehype-raw 必须在 rehype-katex 之前——先把 raw HTML 解析成 HAST 元素，
// 再让 katex 处理 math 节点（math 节点本身是 remark-math 在 mdast 阶段生成的，
// 已是合法节点不会被 raw 重解析，但若反过来 katex 渲染出的 HTML 会被 raw 当
// 文本再解析一次，破坏 KaTeX 输出）。
import { useState } from 'react';
import type { ReactNode } from 'react';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import 'katex/dist/katex.min.css';

// 静态资产前缀。优先取 env（生产部署可能改到 CDN），缺省 /assets/ 走 Vite proxy。
const ASSET_BASE = (import.meta.env.VITE_ASSET_BASE_URL as string) || '/assets/';

/** 把 DB 里的相对图片路径补成可访问 URL；已是绝对 URL（http(s)://）或 data: 直接透传。 */
export const resolveAsset = (p: string): string =>
  /^https?:\/\//.test(p) || p.startsWith('data:') ? p : `${ASSET_BASE}${p.replace(/^\/+/, '')}`;

// LLM 输出 JSON 时把换行双转义成 \\n，json.loads 后变成字面 \n（0x5C 0x6E，
// 反斜杠+n），react-markdown 不认字面 \n（CommonMark 反斜杠转义只对 ASCII
// 标点生效），原样显示成文本。这里把字面 \n 还原成真换行（0x0A）。避开 LaTeX
// 命令首字母（\ne \newline \nonumber \nabla \neg \nu 等）：\n 后跟字母的不动。
// MVP 前端兼容，管线层修复见 data-refinery 后续文档。
//
// 同时调 repairHtml 修 LLM 抽取题面时常见的 HTML 残缺（<tr<td> 缺 >）→ <tr><td>。
// 前端兜底：已有库数据无需重跑 data-refinery 管线即生效；管线层 extract.py 的
// repair_malformed_html 是治本（新入库数据已干净）。
const TAG_LT_RE = /<([a-zA-Z][a-zA-Z0-9]*)(?=<)/g;

/** 修 HTML 残缺：`<tr<td>` 缺 `>` 的写法 → `<tr><td>`。详见 data-refinery extract.py repair_malformed_html。 */
export function repairHtml(text: string | undefined | null): string {
  if (!text || !text.includes('<')) return text ?? '';
  return text.replace(TAG_LT_RE, '<$1>');
}

export const preprocessMarkdown = (s: string | undefined | null): string => {
  if (!s) return '';
  return repairHtml(s.replace(/\\n(?![a-zA-Z])/g, '\n'));
};

/** 标准 remark 插件集：数学 + GFM（表格/删除线/任务列表）。 */
export const markdownRemarkPlugins = [remarkMath, remarkGfm];

/** remark 插件集（带换行保留）：草稿预览 / 学生作答等需要尊重软换行的场景。 */
export const markdownRemarkPluginsWithBreaks = [remarkMath, remarkGfm, remarkBreaks];

/** 标准 rehype 插件集：原生 HTML 解析 + KaTeX 数学渲染。顺序见文件头注释。 */
export const markdownRehypePlugins = [rehypeRaw, rehypeKatex];

interface MarkdownImgProps {
  src?: string;
  alt?: string;
  /** 自定义 className（不同上下文图片尺寸差异大：题面 inline 小图、卡片正文大图、聊天气泡中图）。
   *  启用 bucketHeight 时 className 不要带固定高——高度由分桶算法给（见下）。 */
  className?: string;
  /** 题面图按宽高比分桶固定高度（仅题面图启用）：
   *  ratio = naturalWidth / naturalHeight；∈ [0.3,1.7] → 100px（近正方形）；
   *  < 0.3 → 160px（竖高图）；> 1.7 → 30px（宽矩形）。
   *  onLoad 后按自然尺寸落桶；默认 100px（中间桶）避免首屏过高。宽按比例自适应（max-w-full 兜底）。 */
  bucketHeight?: boolean;
}

/**
 * 默认 img：补 /assets/ 前缀（resolveAsset）+ 破图隐藏（onError）。
 * 默认 className 偏 inline 小尺寸（题面/题块/列表项常用）；卡片正文等需要大图的
 * 场景通过 className 覆盖（如 CourseDetailPage 用 max-h-[60vh]）。
 * 题面图通过 bucketHeight 启用按宽高比分桶固定高度（见 prop 注释）。
 */
export function MarkdownImg({ src, alt, className, bucketHeight }: MarkdownImgProps) {
  // 分桶高度状态：bucketHeight=true 时生效，null 表示不参与 className 拼装。
  // 必须无条件调 useState（hooks 规则）——bucketHeight 在调用点是常量，不会切换。
  const [bucketClass, setBucketClass] = useState<string | null>(bucketHeight ? 'h-[100px]' : null);
  const finalClass = bucketHeight
    ? `${className ?? ''} ${bucketClass ?? ''}`.trim()
    : (className ?? 'block mx-auto my-2 max-w-full h-[50px] object-contain rounded-lg');
  return (
    <img
      src={src ? resolveAsset(src) : ''}
      alt={alt ?? ''}
      className={finalClass}
      onLoad={
        bucketHeight
          ? (e) => {
              const img = e.currentTarget;
              const w = img.naturalWidth;
              const h = img.naturalHeight;
              if (!w || !h) return;
              const ratio = w / h;
              setBucketClass(ratio < 0.3 ? 'h-[160px]' : ratio > 1.7 ? 'h-[30px]' : 'h-[100px]');
            }
          : undefined
      }
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
    />
  );
}

/**
 * 默认 components：img + 表格带 border（题面/题块/解析里 HTML 表格与 GFM 表格
 * 都画出表格线，clear 可读）。其余元素用 react-markdown 默认。多数调用方够用；
 * 聊天气泡（DiscussChat/AdminChat/AuxChatPanel）有自己的 components 自定义
 * table 样式，不用这套默认。border 用 var(--bg-subtle) 适配三套主题
 * （student-day/night/parent 都定义了 --bg-subtle）。
 */
export const markdownComponents = {
  img: MarkdownImg,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => <thead>{children}</thead>,
  tbody: ({ children }: { children?: ReactNode }) => <tbody>{children}</tbody>,
  tr: ({ children }: { children?: ReactNode }) => <tr>{children}</tr>,
  th: ({ children }: { children?: ReactNode }) => (
    <th className="border border-[var(--bg-subtle)] px-2.5 py-1 text-left font-semibold bg-[var(--bg-base)] align-middle">
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="border border-[var(--bg-subtle)] px-2.5 py-1 align-middle">
      {children}
    </td>
  ),
};
