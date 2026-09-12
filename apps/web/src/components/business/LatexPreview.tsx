import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  markdownRemarkPluginsWithBreaks,
  markdownRehypePlugins,
  markdownComponents,
} from '@/components/markdown';

/** CJK 字符（含全角标点 / 全角符号）——必须留在数学模式外，KaTeX 无法渲染中文 */
const CJK_CHAR = /[一-鿿　-〿＀-￯]/;
/** 连续 CJK 段（带捕获组，split 后保留分隔段） */
const CJK_RUN = /([一-鿿　-〿＀-￯]+)/;
/** 数学触发语法：\命令、上下标、四则运算与关系符（+ - * / = < > 等）。命中则该段需用 $...$ 包裹 */
const LATEX_TRIGGER = /\\[a-zA-Z]|\^|_|[+\-*/=<>×÷±≤≥≠≈]/;
/** 3 个及以上连续字母视为英文单词——error-level / and/or / sin x 不当数学 */
const WORD_RUN = /[A-Za-z]{3,}/;
/** TeX 里语义特殊、包进 $ 会静默吞内容（% 注释）或报错（# &）的字符 */
const TEX_HAZARD = /[%#&]/;
/** 行内 Markdown 语法（代码 / 加粗 / 删除线 / 链接 / 图片）——命中则本段不包 $，避免把语法吞进公式 */
const MD_INLINE = /`|\*\*|__|~~|\]\(|\)\[|!\[|\[\^/;
/** 强调语法：整段被 * 或 _ 首尾包围（`*斜体*`）——是 Markdown 不是算式 */
const MD_EMPHASIS = /^(?:\*[^*]+\*|_[^_]+_)$/;
/** 行首 Markdown 结构记号（列表 / 引用 / 标题）：只剥掉记号，记号后的正文照常判定 */
const MD_PREFIX = /^(?:\s*(?:[-+*]|\d+[.)]|#{1,6}|>)\s+)+/;
/** HTML 标签（`<tr>` / `</td>` / `<br/>` / 打字中的 `<tr`）：交给 rehype-raw 渲染，不能包进 $…$ */
const HTML_TAG_START = /^<\/?[a-zA-Z!]/;
/** 已显式标注的区域，原样保留、不参与自动补 $：$$…$$（可跨行）、围栏代码块、行内代码、$…$
 *  （围栏必须排在行内代码之前，否则 ``` 会被当成一个空的 `…` 行内代码先吃掉） */
const PROTECTED_RE = /(\$\$[\s\S]*?\$\$|```[\s\S]*?```|`[^`\n]*`|\$[^$\n]*\$)/g;

/** 单个裸文本段是否需要包成 $...$（core 为去掉两侧空白后的内容）。 */
function shouldWrap(core: string): boolean {
  if (!core) return false;
  if (core.includes('$')) return false; // 未配对的 $（学生打字中）：本段保持原样
  if (HTML_TAG_START.test(core)) return false;
  if (TEX_HAZARD.test(core)) return false;
  if (MD_INLINE.test(core) || MD_EMPHASIS.test(core)) return false;
  if (/\\[a-zA-Z]/.test(core)) return true; // LaTeX 命令优先（\frac 里的 frac 不算英文单词）
  if (WORD_RUN.test(core)) return false;
  if (!/[A-Za-z0-9\\]/.test(core)) return false; // 纯符号段（单独的 * - / =）是标点不是公式
  return LATEX_TRIGGER.test(core);
}

/** 按 CJK 边界切段，需包 $ 的段整体包入（两侧空白留在 $ 外）。 */
function wrapSegments(text: string): string {
  return text
    .split(CJK_RUN)
    .map(part => {
      if (!part || CJK_CHAR.test(part)) return part; // CJK 段：纯文本
      const lead = part.match(/^\s*/)![0];
      const tail = part.match(/\s*$/)![0];
      const core = part.slice(lead.length, part.length - tail.length);
      return shouldWrap(core) ? `${lead}$${core}$${tail}` : part;
    })
    .join('');
}

/** 处理单行裸文本：剥掉行首结构记号后判定正文，保留 Markdown 结构。 */
function wrapBareLine(line: string): string {
  // 表格行：按 | 拆成单元格分别判定，竖线原样保留
  //（整行一起判定会把 | 和单元格内容全包进一个公式，表格垮掉）
  if (/^\s*\|/.test(line)) return line.split('|').map(wrapSegments).join('|');
  // 列表 / 引用 / 标题行：只剥掉行首记号再判定正文
  //（不能整行跳过——`- x^2`、`## x^2` 里的公式也要能渲染；也不能整行包 $——会把列表符号当减号、标题失效）
  const prefix = line.match(MD_PREFIX)?.[0] ?? '';
  return prefix + wrapSegments(line.slice(prefix.length));
}

/**
 * 把「裸 LaTeX / 裸数学式」按需补上 $...$，供 KaTeX 渲染。
 *
 * 规则：
 * 1. 已显式标注的区域（$$…$$、$…$、行内代码）原样保留——判定必须**逐段**做，
 *    不能整段看「有没有 $」：那样一处 $ 会让全篇都不再自动补，
 *    「第一行 \triangle、第二行 $x=1$」会退化成字面文本。
 * 2. 其余裸文本逐行（内联 $...$ 不跨行）、按 CJK 边界切段；CJK 段保持纯文本，
 *    非 CJK 段命中 LATEX_TRIGGER（\命令 / ^ / _ / + - * / = < > 等）则整体
 *    包入 $...$，两侧空白留在 $ 外。
 * 3. 先剥掉行首 Markdown 记号（列表 / 引用 / 标题）再判定正文，记号本身不参与，
 *    这样 `- x^2`、`## x^2` 既保住 Markdown 结构、公式也能渲染。
 * 4. 行内 Markdown（加粗 / 删除线 / 链接 / 图片）、HTML 标签、英文单词、TeX 特殊字符
 *    （% # &）一律不包，避免把 Markdown 语法 / HTML 标签吞进公式或让 KaTeX 报错。
 * 5. 自动补的 $ 若紧贴用户写的 $ 会连成 $$（remark-math 会把它当成一个公式，
 *    实测 $\triangle$$x=1$ 渲染报错），故在两段之间补一个空格。
 *
 * 例：\frac{a}{b} -> $\frac{a}{b}$；a+b=1 -> $a+b=1$；<tr> -> 不变（HTML）；
 *     \triangle 换行 $x=1$ -> $\triangle$ 换行 $x=1$；
 *     因为 x^2 所以 -> 因为 $x^2$ 所以；- x^2 -> - $x^2$；## x^2 -> ## $x^2$；
 *     | a-b | 1 | -> | $a-b$ | 1 |；x^2和y^2 -> $x^2$和$y^2$；
 *     and/or、error-level -> 不变（含英文单词）；a=50% -> 不变（TeX 特殊字符）
 */
export function autoWrapMath(text: string): string {
  const segments = text
    .split(PROTECTED_RE)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.split('\n').map(wrapBareLine).join('\n')));
  return segments.reduce((acc, seg) =>
    acc.endsWith('$') && seg.startsWith('$') ? `${acc} ${seg}` : acc + seg,
  );
}

export function LatexPreview({ value }: { value: string }) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 150);
    return () => clearTimeout(t);
  }, [value]);

  const wrapped = autoWrapMath(debounced);

  return (
    <div className="h-full overflow-auto p-4 text-[var(--text-primary)]">
      {wrapped.trim() ? (
        // learn-prose：项目自有的 Markdown 排版类（global.css §Learn Prose，标题/列表/引用/图片）。
        // 不要写 `prose`——项目没装 @tailwindcss/typography，那个类是死的，会让标题看起来跟正文一样。
        <div className="learn-prose">
          <ReactMarkdown remarkPlugins={markdownRemarkPluginsWithBreaks} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
            {wrapped}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="text-[var(--text-secondary)] text-sm">预览区（输入后实时渲染）</p>
      )}
    </div>
  );
}
