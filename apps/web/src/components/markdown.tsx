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
//   5. 块级 HTML 吞并修复：CommonMark 把「行首块级 HTML 标签」当 HTML 块一直吃到下一个
//      空行；LLM 题面常在 </table> 后直接接 markdown（无空行），后续内容会被吞进同一个
//      raw html 节点变成纯文本。remarkSplitHtmlBlocks 插件在 mdast 阶段切分修复（见下）。
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
import type { Options } from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkParse from 'remark-parse';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import type { Content, Root } from 'mdast';
// KaTeX 字体通过 scripts/setup-katex-fonts.cjs 复制到 public/katex-fonts/，
// 并生成 src/styles/katex-fonts.css（修正 @font-face 路径为绝对路径 /katex-fonts/）。
// 先加载完整 CSS（含 .katex/.katex-html 等布局样式），再加载修正路径后的 @font-face
// 覆盖原 CSS 中的字体声明，解决 Vite dev 模式下 url(fonts/...) 解析失败导致的字体 404
// 和数学公式渲染错位（根号横线缺失）。
import 'katex/dist/katex.min.css';
import '@/styles/katex-fonts.css';

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

// ── 富文本归一化（真实入库内容兜底）──
// 1) $$…$$ 公式：remark-math 只把「$$ 独占一行」识别为块级（display）公式；管线/LLM
//    产出的 `$$\begin{aligned}…\end{aligned}$$`（$$ 后紧跟内容）会被当行内 math 解析并
//    抛 KaTeX parse error。这里把每处 $$ 规整到独占一行，恢复 display。
// 2) 内嵌 <svg> 的围栏代码块：几何题解常写成 ```xml\n<svg…>…</svg>\n```，围栏会被渲染成
//    <pre><code>（转义文本）而非图形；这里解包「内容以 <svg 开头」的围栏，交给 rehype-raw
//    当真实 SVG 元素渲染。
// 归一化必须避开代码区（围栏块 / 行内 code），否则会破坏真正的代码示例。
const FENCED_CODE_RE = /(```[\s\S]*?```)/g;
const INLINE_CODE_RE = /(`[^`]*`)/g;
const SVG_FENCE_RE = /```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g;

/** 解包「内容为 <svg>」的围栏代码块：去掉 ``` 外壳，保留原始 SVG。 */
const unwrapSvgFences = (s: string): string =>
  s.replace(SVG_FENCE_RE, (m, body: string) =>
    /^\s*<svg[\s>]/i.test(body) ? `\n${body.trim()}\n` : m,
  );

/** 把 $$ 规整为独占一行（跳过行内 code）。函数 replacer 避免 `$$` 被当替换模式。 */
const normalizeMathDelimiters = (s: string): string =>
  s
    .split(INLINE_CODE_RE)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/\$\$/g, () => '\n$$\n')))
    .join('');

/** 对围栏代码块之外的文本应用 fn（代码块原样保留）。 */
const mapOutsideFences = (s: string, fn: (t: string) => string): string =>
  s
    .split(FENCED_CODE_RE)
    .map((seg, i) => (i % 2 === 1 ? seg : fn(seg)))
    .join('');

export const preprocessMarkdown = (s: string | undefined | null): string => {
  if (!s) return '';
  const restored = repairHtml(s.replace(/\\n(?![a-zA-Z])/g, '\n'));
  return mapOutsideFences(unwrapSvgFences(restored), normalizeMathDelimiters);
};

// ── CommonMark HTML 块吞并修复（remarkSplitHtmlBlocks）──
// CommonMark 规则：行首为块级 HTML 标签（<table> 等）时会进入「HTML 块」解析，一直吃到
// 下一个空行。LLM 抽取/生成的题面常在 </table> 等闭合标签后直接接 markdown 段落（无空行），
// 导致其后的 markdown/LaTeX 全部被吞进同一个 raw html 节点，rehype-raw 只会把它当普通文本
// 输出（<p>、**加粗**、$..$ 全部失效）。
// 此插件在 mdast 阶段把这类 html 节点按「最后一个块级闭合标签行」切分：闭合标签之后的
// 非空且非 < 开头的内容视为新的 markdown 段落，用嵌套 remark 处理器（tailPlugins 与主管线
// 一致）重新解析后插回树中，恢复后续内容的正常渲染。
const BLOCK_HTML_CLOSE_END_RE =
  /<\/(?:table|div|p|ul|ol|li|h[1-6]|pre|blockquote|section|article|figure|details|summary|tbody|thead|tfoot|tr|td|th|caption|colgroup|dl|dt|dd|address|aside|center|fieldset|figcaption|footer|form|header|main|nav)(?:\s[^>]*)?>\s*$/;
const STANDALONE_HR_LINE_RE = /^[ \t]*<hr(?:\s[^>]*)?\/?>\s*$/;
const HTML_LINE_START_RE = /^\s*</;

function splitGreedyHtmlBlock(value: string): { html: string; md: string } | null {
  const lines = value.split('\n');
  // 最后一个「块级闭合标签行」下标；之后第一个非空、非 < 开头的行即为 markdown 起点。
  let lastClose = -1;
  for (let i = 0; i < lines.length; i++) {
    if (BLOCK_HTML_CLOSE_END_RE.test(lines[i]) || STANDALONE_HR_LINE_RE.test(lines[i])) {
      lastClose = i;
    }
  }
  if (lastClose === -1) return null; // 无块级闭合标签（纯行内 HTML），不切分
  let mdStart = -1;
  for (let i = lastClose + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      mdStart = i;
      break;
    }
  }
  if (mdStart === -1) return null; // 纯 HTML 块，无需切分
  if (HTML_LINE_START_RE.test(lines[mdStart])) return null; // 后续仍是未闭合 HTML，不切分
  return { html: lines.slice(0, mdStart).join('\n'), md: lines.slice(mdStart).join('\n') };
}

/** remark 插件：切分被 CommonMark HTML 块吞并的 markdown 尾部（见上注释）。 */
function remarkSplitHtmlBlocks(tailPlugins: NonNullable<Options['remarkPlugins']>) {
  // 尾部重新解析用的嵌套处理器（与主管线同款插件，保证 $..$/表格等规则一致）
  const tailProcessor = unified().use(remarkParse).use(tailPlugins);
  return () => (tree: Root) => {
    visit(tree, 'html', (node, index, parent) => {
      if (parent == null || index == null) return;
      const parts = splitGreedyHtmlBlock(node.value);
      if (!parts) return;
      const tail = tailProcessor.parse(parts.md);
      // 原 html 节点截为纯 HTML 部分，尾部按 markdown 重新解析后插入其后
      parent.children.splice(index, 1, { ...node, value: parts.html }, ...(tail.children as Content[]));
    });
  };
}

/** 标准 remark 插件集：数学 + GFM（表格/删除线/任务列表）+ 块级 HTML 吞并修复。 */
export const markdownRemarkPlugins: NonNullable<Options['remarkPlugins']> = [
  remarkMath,
  remarkGfm,
  remarkSplitHtmlBlocks([remarkMath, remarkGfm]),
];

/** remark 插件集（带换行保留）：草稿预览 / 学生作答等需要尊重软换行的场景。 */
export const markdownRemarkPluginsWithBreaks: NonNullable<Options['remarkPlugins']> = [
  remarkMath,
  remarkGfm,
  remarkBreaks,
  remarkSplitHtmlBlocks([remarkMath, remarkGfm, remarkBreaks]),
];

/** 标准 rehype 插件集：原生 HTML 解析 + KaTeX 数学渲染。顺序见文件头注释。
 *
 * KaTeX 默认 output: 'htmlAndMathml'，同时输出 HTML 视觉层 + MathML 语义层。
 * Chrome 109+ 开始原生支持 MathML，其渲染可能与 KaTeX 的 CSS 定位冲突，
 * 导致根号横线错位（如 \sqrt{8} 显示为 /8）。强制 output: 'html' 只保留
 * CSS 视觉渲染，彻底规避 MathML 与 HTML 层的重叠/错位问题。
 */
// 原始几何示意图 <svg>（rehype-raw 从题解 HTML 解析而来）带 SVG 连字符属性
// （font-size / stroke-width …）。react-markdown 对 SVG 命名空间识别有限，连字符属性
// 直接透传会触发 React "Invalid DOM property `font-size`" 警告。统一转成 camelCase
// （React 对 SVG 属性两种写法都接受，camelCase 为惯用）。KaTeX 输出已是 camelCase，不受影响。
const SVG_ATTR_CAMEL: Record<string, string> = {
  'font-size': 'fontSize',
  'font-weight': 'fontWeight',
  'font-family': 'fontFamily',
  'text-anchor': 'textAnchor',
  'dominant-baseline': 'dominantBaseline',
  'stroke-width': 'strokeWidth',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'fill-opacity': 'fillOpacity',
  'stroke-opacity': 'strokeOpacity',
  'fill-rule': 'fillRule',
  'clip-rule': 'clipRule',
  'clip-path': 'clipPath',
  'marker-width': 'markerWidth',
  'marker-height': 'markerHeight',
  'marker-end': 'markerEnd',
  'marker-start': 'markerStart',
  'marker-mid': 'markerMid',
};

function rehypeSvgAttrNames() {
  return (tree: Root) => {
    visit(tree, 'element', (node) => {
      const props = (node as { properties?: Record<string, unknown> }).properties;
      if (!props) return;
      for (const [kebab, camel] of Object.entries(SVG_ATTR_CAMEL)) {
        if (kebab in props) {
          props[camel] = props[kebab];
          delete props[kebab];
        }
      }
    });
  };
}

export const markdownRehypePlugins: NonNullable<Options['rehypePlugins']> = [
  rehypeRaw,
  [rehypeKatex, { output: 'html' }],
  rehypeSvgAttrNames,
];

interface MarkdownImgProps {
  src?: string;
  alt?: string;
  /** 自定义 className（不同上下文图片尺寸差异大：题面 inline 小图、卡片正文大图、聊天气泡中图）。
   *  启用 bucketHeight 时 className 不要带固定高——高度由分桶算法给（见下）。 */
  className?: string;
  /** 题面图按宽高比分桶固定高度（仅题面图启用）：
   *  ratio = naturalWidth / naturalHeight；> 5 → 60px（超宽矩形）；
   *  其它 → 120px。
   *  onLoad 后按自然尺寸落桶；默认 120px（常见桶）避免首屏过高。宽按比例自适应（max-w-full 兜底）。 */
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
  const [bucketClass, setBucketClass] = useState<string | null>(bucketHeight ? 'h-[120px]' : null);
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
              setBucketClass(ratio > 5 ? 'h-[60px]' : 'h-[120px]');
            }
          : undefined
      }
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
    />
  );
}

/**
 * 默认 components：img + 表格带 border（题面/题块/解析里 HTML 表格与 GFM 表格
 * 都画出表格线，clear 可读）。其余元素用 react-markdown 默认。
 *
 * ⚠️ 不覆盖 <svg>：KaTeX 数学公式（\sqrt{}、分数线等）内部使用 SVG 绘制符号，
 * 若全局覆盖 svg 的 className（如加 h-auto/w-auto），会破坏 KaTeX 的 SVG 尺寸
 * 计算，导致根号横线缺失、公式错位。几何插图 SVG 的缩放问题后续另行处理。
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
