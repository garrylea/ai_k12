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
import { Children, isValidElement, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
// 题干图 → 草稿的指针拖拽（draggableQuestionMarkdownComponents 的 img 起拖时调用）
import { beginImageDrag, wasJustDragged } from './business/draft-image-drag';

// 静态资产前缀。优先取 env（生产部署可能改到 CDN），缺省 /assets/ 走 Vite proxy。
const ASSET_BASE = (import.meta.env.VITE_ASSET_BASE_URL as string) || '/assets/';

/**
 * 把 DB 里的相对图片路径补成可访问 URL。三类直接透传：
 * 1) `http(s)://` 已是绝对 URL；
 * 2) `data:` 内联；
 * 3) `/uploads/…` —— 用户上传走的是后端**另一个**静态根（`/uploads/`），
 *    自身已是绝对路径。若不特判就会被补成 `/assets/uploads/…`，
 *    而 `/assets/` 与 `/uploads/` 是两棵独立的目录树，两边都不命中 → 全链路 404。
 *    （同口径硬注释见 pages/parent-mobile/MobileChatLogsPage.tsx:66-69）
 * 其余（`questions/math/…/x.jpg` 等管线产物）才补 ASSET_BASE。
 */
export const resolveAsset = (p: string): string =>
  /^https?:\/\//.test(p) || p.startsWith('data:') || p.startsWith('/uploads/')
    ? p
    : `${ASSET_BASE}${p.replace(/^\/+/, '')}`;

// LLM 输出 JSON 时把换行双转义成 \\n，json.loads 后变成字面 \n（0x5C 0x6E，
// 反斜杠+n），react-markdown 不认字面 \n（CommonMark 反斜杠转义只对 ASCII
// 标点生效），原样显示成文本。这里把字面 \n 还原成真换行（0x0A）。避开 LaTeX
// 命令首字母（\ne \newline \nonumber \nabla \neg \nu 等）：\n 后跟字母的不动。
// MVP 前端兼容，管线层修复见 data-refinery 后续文档。
//
// 同时调 repairHtml 修 LLM 抽取题面时常见的 HTML 残缺（<tr<td> 缺 >）→ <tr><td>。
// 前端兜底：已有库数据无需重跑 data-refinery 管线即生效；管线层 extract.py 的
// repair_malformed_html 是治本（新入库数据已干净）。
const BROKEN_TAG_RE =
  /<([A-Za-z][A-Za-z0-9]*)(?=<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*)?\/?>)/g;

/**
 * 修 HTML 残缺：`<tr<td>` 缺 `>` 的写法 → `<tr><td>`。
 *
 * **判据是结构，不是标签名**：只有当 `<name` 后面紧跟**一整只合法标签**
 * （`<t>` / `</t>` / `<t attr="…">`，必须有闭合的 `>`）时，才认定这个 `name`
 * 是漏了 `>` 的残缺标签。只凭「`<` 后跟字母」会误伤数学里的一切不等式链：
 * `0<AM<5`（`<5` 不是标签）、`$2<a<3$`（`<3` 不是标签）、`$m<n$`，
 * 被补成 `<AM>` / `<a>` 后 rehype-raw 解析出幽灵元素，后面的内容全被吞掉
 * （2026-11-03 数学真题 86419 第 8 题 ② 小问只剩 `0<5`）。
 *
 * 连续残缺（`<table<tr<td>`）靠反复替换收敛：第一轮修 `<tr`（后面是完整的
 * `<td>`），第二轮 `<table` 后面已是 `<tr>` 才够格。
 *
 * 详见 data-refinery extract.py repair_malformed_html（同口径）。
 */
export function repairHtml(text: string | undefined | null): string {
  if (!text || !text.includes('<')) return text ?? '';
  let out = text;
  // 链式残缺的深度 = 连续漏 `>` 的标签个数；8 轮足够，另有兜底上限防死循环。
  for (let i = 0; i < 8; i++) {
    const next = out.replace(BROKEN_TAG_RE, '<$1>');
    if (next === out) break;
    out = next;
  }
  return out;
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

/**
 * 把 LaTeX 的 `\[ … \]` / `\( … \)` 归一为 remark-math 认得的 `$$ … $$` / `$ … $`。
 *
 * 背景（2026-11-01 用户报告）：LLM 生成的题目解析常写成标准 LaTeX 的 display math
 * `\[ \text{做功改变内能} \]`，而 **remark-math 只识别 `$` 系定界符**，`\[…\]` 会原样
 * 当普通文本输出（页面上就是字面 `[ \text{做功改变内能} ]`）。同一份解析在考试结果页与
 * 练习记录详情页都要渲染，所以在共享的 preprocessMarkdown 里统一归一，一处修、全局生效。
 *
 * 注意顺序：必须先归一 `\[…\]`（产出 `$$`）再由 normalizeMathDelimiters 规整为独占一行，
 * 否则 `$$` 后紧跟内容会被当行内 math 解析并抛 KaTeX parse error。
 * 代码块内不处理（由 mapOutsideFences 保证）。
 */
const normalizeLatexBrackets = (s: string): string =>
  s
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `\n$$\n${body}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body}$`);

/** 对围栏代码块之外的文本应用 fn（代码块原样保留）。 */
const mapOutsideFences = (s: string, fn: (t: string) => string): string =>
  s
    .split(FENCED_CODE_RE)
    .map((seg, i) => (i % 2 === 1 ? seg : fn(seg)))
    .join('');

export const preprocessMarkdown = (s: string | undefined | null): string => {
  if (!s) return '';
  const restored = repairHtml(s.replace(/\\n(?![a-zA-Z])/g, '\n'));
  return mapOutsideFences(unwrapSvgFences(restored), (t) =>
    normalizeMathDelimiters(normalizeLatexBrackets(t)),
  );
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

// ── 原生 HTML 里的 $…$ 公式 ────────────────────────────────────────────────
// remark-math 只处理 markdown 文本节点，**不解析 raw HTML 内部**。LLM/题库生成的
// 标准答案常把公式写进 HTML 表格单元格（如 `<td> $S/mm^{2}$ </td>`），rehype-raw
// 把表格解析成元素后，单元格里的 `$S/mm^{2}$` 就成了一串普通文本 → 页面上原样显示
// 美元符号（2026-11-02 用户报告：物理第 30 题实验数据记录表）。
//
// 修法：rehype-raw 之后、rehype-katex 之前，把文本节点里的 `$$…$$` / `$…$` 包成
// `<span class="math math-inline">` / `<div class="math math-display">`（正是
// remark-math 产出的形状），交给 rehype-katex 正常渲染。remark-math 已处理的公式
// 是 math 节点（文本里没有 `$`），不会被二次命中；`code`/`pre` 内跳过。
interface HastLike {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
}

/** 前面已有定界符的 $…$（$$ 优先），行内公式要求紧贴内容、不跨行。 */
const MATH_IN_HTML_RE = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
const MATH_SKIP_TAGS = new Set(['code', 'pre', 'style', 'script', 'textarea']);

const mathElement = (tex: string, display: boolean): HastLike =>
  display
    ? { type: 'element', tagName: 'div', properties: { className: ['math', 'math-display'] }, children: [{ type: 'text', value: tex }] }
    : { type: 'element', tagName: 'span', properties: { className: ['math', 'math-inline'] }, children: [{ type: 'text', value: tex }] };

/** 把一段文本按公式切成 [文本, 公式, 文本…]；没有公式返回 null。 */
function splitMathText(value: string): HastLike[] | null {
  const out: HastLike[] = [];
  let last = 0;
  let matched = false;
  for (const m of value.matchAll(MATH_IN_HTML_RE)) {
    const [full, displayTex, inlineTex] = m;
    const display = displayTex !== undefined;
    const tex = display ? displayTex : inlineTex;
    // 行内公式不能以空白开头/结尾（$ 100 元 $、$100 到 $200 里的第二段都不算公式）。
    if (!display && (/^\s/.test(tex) || /\s$/.test(tex))) continue;
    const start = m.index ?? 0;
    if (start > last) out.push({ type: 'text', value: value.slice(last, start) });
    out.push(mathElement(tex, display));
    last = start + full.length;
    matched = true;
  }
  if (!matched) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function rehypeMathInHtml() {
  return (tree: HastLike) => {
    const walk = (node: HastLike, insideSkip: boolean) => {
      if (!node.children) return;
      const skip = insideSkip || (node.type === 'element' && MATH_SKIP_TAGS.has(node.tagName ?? ''));
      const next: HastLike[] = [];
      for (const child of node.children) {
        if (child.type === 'text' && !skip && child.value) {
          const parts = splitMathText(child.value);
          if (parts) {
            next.push(...parts);
            continue;
          }
        }
        walk(child, skip);
        next.push(child);
      }
      node.children = next;
    };
    walk(tree, false);
  };
}

export const markdownRehypePlugins: NonNullable<Options['rehypePlugins']> = [
  rehypeRaw,
  rehypeMathInHtml,
  [rehypeKatex, { output: 'html' }],
  rehypeSvgAttrNames,
];

export interface MarkdownImgProps {
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
  /** 点图放大（默认开）。选项按钮里也生效，点图不会顺带选中该选项。 */
  zoomable?: boolean;
  /** 可作为「拖进草稿」的图源（题干/材料启用）：移动 >10px 起拖，<=10px 仍是点击放大 */
  dragToDraft?: boolean;
}

/** 起拖阈值（CSS px）：小于它仍按点击处理（点图放大），避免轻触就拖走 */
const DRAFT_DRAG_THRESHOLD = 10;

/**
 * 默认 img：补 /assets/ 前缀（resolveAsset）+ 破图隐藏（onError）。
 * 默认 className 偏 inline 小尺寸（题面/题块/列表项常用）；卡片正文等需要大图的
 * 场景通过 className 覆盖（如 CourseDetailPage 用 max-h-[60vh]）。
 * 题面图通过 bucketHeight 启用按宽高比分桶固定高度（见 prop 注释）。
 */
export function MarkdownImg({ src, alt, className, bucketHeight, zoomable = true, dragToDraft }: MarkdownImgProps) {
  // 分桶高度状态：bucketHeight=true 时生效，null 表示不参与 className 拼装。
  // 必须无条件调 useState（hooks 规则）——bucketHeight 在调用点是常量，不会切换。
  const [bucketClass, setBucketClass] = useState<string | null>(bucketHeight ? 'h-[120px]' : null);
  const [zoom, setZoom] = useState(false);
  // 按下点（仅在 dragToDraft 时使用）：起拖后置 null，同一次按下只起一次拖
  // pointerId 一并记下：iPad 上第二根手指/手掌落到同一张图时，move/up 必须按 id 过滤，
  // 否则副指针能凭空起拖，且它抬手就清掉主指针正在进行的按下
  const dragOriginRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const finalClass = (bucketHeight
    ? `${className ?? ''} ${bucketClass ?? ''}`.trim()
    : (className ?? 'block mx-auto my-2 max-w-full h-[50px] object-contain rounded-lg'))
    + (zoomable ? ' cursor-zoom-in' : '');
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  // 拖进草稿（指针事件，鼠标/触屏/手写笔同一套；iPad Safari 不支持 HTML5 拖拽）：
  // 位移超过阈值才开始拖，否则保持「点图放大」。touch-action:pan-y 保留纵向滚动。
  const onImgPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!dragToDraft || !e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragOriginRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onImgPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const origin = dragOriginRef.current;
    if (!origin || origin.pointerId !== e.pointerId) return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) <= DRAFT_DRAG_THRESHOLD) return;
    dragOriginRef.current = null; // 一次按下只起一次拖
    beginImageDrag({ src: resolveAsset(src ?? ''), pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY });
  };

  const endImgDrag = (e: React.PointerEvent<HTMLImageElement>) => {
    const origin = dragOriginRef.current;
    if (origin && origin.pointerId !== e.pointerId) return; // 副指针抬手不结束主指针的按下
    dragOriginRef.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const zoomOverlay = zoom && createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="放大图片"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4"
      onClick={() => setZoom(false)}
    >
      <img
        src={resolveAsset(src ?? '')}
        alt={alt ?? ''}
        className="max-h-[90vh] max-w-[92vw] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
  return (
    <>
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
      // 拖源（仅题干/材料图）：按下记原点，位移过阈值交给拖拽模块；draggable=false 关掉浏览器原生图片拖拽
      onPointerDown={dragToDraft ? onImgPointerDown : undefined}
      onPointerMove={dragToDraft ? onImgPointerMove : undefined}
      onPointerUp={dragToDraft ? endImgDrag : undefined}
      onPointerCancel={dragToDraft ? endImgDrag : undefined}
      draggable={dragToDraft ? false : undefined}
      style={dragToDraft ? { touchAction: 'pan-y', WebkitTouchCallout: 'none', userSelect: 'none' } : undefined}
      // 点图放大：stopPropagation 避免在「选项按钮」里点图被当成选中选项。
      // 刚拖完的 click（松手就落在图上）不再打开放大浮层，否则拖动结束立刻弹大图。
      onClick={zoomable ? (e) => { e.stopPropagation(); if (wasJustDragged()) return; setZoom(true); } : undefined}
      title={zoomable ? '点击放大' : undefined}
    />
    {zoomOverlay}
    </>
  );
}

/**
 * 图注：紧跟在图片后面、独占一行的短说明。
 *
 * 两种写法都算：整体编号「图1 / 图 3 / 图2-1」，以及分格小标「甲 / 乙 / 丙 / 丁」
 * （物理、化学习题里三幅并排图常用甲乙丙，2026-11-01 人大附物理第 27 题实测）。
 *
 * 题面里的写法是 `![](xxx.jpg)\n图1` 或 `![](a.jpg)\n甲\n![](b.jpg)\n乙`（同一段落）。
 * 默认渲染会把说明当成正文另起一行（或与图并排），看起来像多了一段。这里把
 * 「图 + 紧跟的短说明」收成 <figure>，说明放图片下方居中、小字号、浅灰。
 */
const FIG_CAPTION_RE = /^(?:图\s*[0-9一二三四五六七八九十]+(?:[-－—]\s*[0-9]+)?\s*[甲乙丙丁]?|[甲乙丙丁])$/;
/** 纯图号（「图5」），后面可能还跟一个分格小标「乙」，要合成「图5乙」。 */
const FIG_NO_ONLY_RE = /^图\s*[0-9一二三四五六七八九十]+(?:[-－—]\s*[0-9]+)?$/;
const PANEL_LETTER_RE = /^[甲乙丙丁]$/;

type ParaBlock =
  | { kind: 'text'; nodes: ReactNode[] }
  | { kind: 'figure'; images: ReactNode[]; caption: string | null };

function MarkdownParagraph({ children }: { children?: ReactNode }) {
  const items = Children.toArray(children);
  // 按 **src 属性**认图，而不是按组件身份：题面区把 img 换成了 MarkdownImg 的包装
  // 组件（QuestionRunner 的 questionMarkdownComponents），`c.type === MarkdownImg`
  // 在那里永远不成立（2026-11-01 实测图注没生效）。
  const isImg = (c: ReactNode) =>
    isValidElement(c) && typeof (c.props as { src?: unknown }).src === 'string';
  const isBlank = (c: ReactNode) => typeof c === 'string' && c.trim() === '';
  const isBreak = (c: ReactNode) => isValidElement(c) && c.type === 'br';

  // 一段里可能有多组「图 + 小标」（三幅并排图的甲乙丙），必须逐个收，不能只看段尾。
  const blocks: ParaBlock[] = [];
  let buf: ReactNode[] = [];
  const flushText = () => {
    if (buf.some((c) => !isBlank(c))) blocks.push({ kind: 'text', nodes: buf });
    buf = [];
  };

  let i = 0;
  while (i < items.length) {
    if (!isImg(items[i])) {
      buf.push(items[i]);
      i += 1;
      continue;
    }
    // 连续的多张图（中间只有空白/换行）算同一幅
    const images: ReactNode[] = [items[i]];
    let j = i + 1;
    while (j < items.length) {
      if (isBlank(items[j]) || isBreak(items[j])) { j += 1; continue; }
      if (isImg(items[j])) { images.push(items[j]); j += 1; continue; }
      break;
    }
    // 紧跟其后的短说明（可能和前后的软换行粘在同一个文本节点里：
    // `乙\n图22` 是「乙」这行 + 下一行的图号，只能取第一行当图注）
    let k = j;
    while (k < items.length && (isBlank(items[k]) || isBreak(items[k]))) k += 1;
    const tail = k < items.length ? items[k] : null;
    const tailText = typeof tail === 'string' ? tail : '';
    // 软换行会让文本节点以 "\n" 开头（`!\[](...)\n图1` → "\n 图1"），
    // 先跳过空行取第一行有效文本当图注，剩下的还归原段落。
    const lines = tailText.split('\n');
    let li = 0;
    while (li < lines.length && !lines[li].trim()) li += 1;
    let caption = (lines[li] ?? '').trim();
    let consumed = li + 1;
    let rest = lines.slice(consumed).join('\n');
    let nextI = k + 1;

    // 原卷把「图5」和分格小标「乙」上下叠着排（人大附题7：中间那幅图下面是 图5 / 乙
    // 两行），拆开渲染会剩一个孤零零的「乙」飘在两张图之间 —— 合成「图5乙」。
    // 两种情况都要收：① 同一个文本节点里 `图5\n乙`（软换行）；
    // ② 行尾两个空格造成硬换行（`图11  \n乙`），「乙」被拆到下一个 item（<br> 之后）。
    if (FIG_NO_ONLY_RE.test(caption)) {
      if (consumed < lines.length && PANEL_LETTER_RE.test((lines[consumed] ?? '').trim())) {
        caption = `${caption}${lines[consumed].trim()}`;
        consumed += 1;
        rest = lines.slice(consumed).join('\n');
      } else {
        // 跨 <br>/空白找下一个文本节点：行尾两空格 → 硬换行 → 「乙」在下一个 item
        let ni = k + 1;
        while (ni < items.length && (isBlank(items[ni]) || isBreak(items[ni]))) ni += 1;
        if (ni < items.length && typeof items[ni] === 'string') {
          const nextLines = (items[ni] as string).split('\n');
          let nli = 0;
          while (nli < nextLines.length && !nextLines[nli].trim()) nli += 1;
          const nextLine = (nextLines[nli] ?? '').trim();
          if (PANEL_LETTER_RE.test(nextLine)) {
            caption = `${caption}${nextLine}`;
            rest = nextLines.slice(nli + 1).join('\n');
            nextI = ni + 1;
          }
        }
      }
    }
    const hasCaption = caption.length > 0 && caption.length <= 10 && FIG_CAPTION_RE.test(caption);
    flushText();
    blocks.push({ kind: 'figure', images, caption: hasCaption ? caption : null });
    if (hasCaption) {
      if (rest.trim()) buf.push(rest);   // 图注后面的正文还归原段落
      i = nextI;
    } else {
      i = j;
    }
  }
  flushText();

  if (!blocks.some((b) => b.kind === 'figure')) {
    return <p>{children}</p>;
  }
  return (
    <div>
      {blocks.map((b, idx) =>
        b.kind === 'figure' ? (
          <figure key={idx} className="my-2 flex flex-col items-center">
            {b.images}
            {b.caption && (
              <figcaption className="mt-1 text-center text-xs text-[var(--text-tertiary)]">
                {b.caption}
              </figcaption>
            )}
          </figure>
        ) : (
          <p key={idx}>{b.nodes}</p>
        ),
      )}
    </div>
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
  p: MarkdownParagraph,
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

/**
 * 作答/结果页的大图样式：与题面小图（默认 `h-[50px]`）区分。
 * 物理电路图、化学装置图按题面规格会被压成一条细线，必须用这套。
 * 40vh 上限是为了让"文字 + 图 + 文字"能在同一屏里读，点开还能放大（zoomable）。
 */
export const ANSWER_IMG_CLASS =
  'block max-w-full max-h-[40vh] my-2 rounded-lg object-contain cursor-zoom-in';

/**
 * 学生作答内容专用的 components 工厂。
 * 必须是工厂/模块级常量、不能在 render 里现造箭头函数——`img` 的组件类型一旦每次渲染都变，
 * React 会把 `<img>` 卸载重挂，等于每次输入都重新下载图片。
 */
export function makeAnswerComponents(imgClassName: string = ANSWER_IMG_CLASS) {
  return {
    ...markdownComponents,
    // node 是 react-markdown 注入的 HAST 节点、不是合法 DOM 属性，必须解构丢弃，
    // 否则会随 rest 透传到 <img> 触发 React 报错。
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    img: ({ node: _node, ...rest }: MarkdownImgProps & { node?: unknown }) => (
      <MarkdownImg {...rest} className={imgClassName} />
    ),
  };
}
