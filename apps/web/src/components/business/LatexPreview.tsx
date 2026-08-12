import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

/** CJK 字符（含全角标点 / 全角符号）——必须留在数学模式外，KaTeX 无法渲染中文 */
const CJK_CHAR = /[一-鿿　-〿＀-￯]/;
/** 连续 CJK 段（带捕获组，split 后保留分隔段） */
const CJK_RUN = /([一-鿿　-〿＀-￯]+)/;
/** LaTeX 触发语法：\命令、上标 ^、下标 _。命中则该段需用 $...$ 包裹 */
const LATEX_TRIGGER = /\\[a-zA-Z]|\^|_/;

/**
 * 把「裸 LaTeX」文本按需补上 $...$，供 KaTeX 渲染。
 *
 * 规则：
 * 1. 文本已含 $（用户显式标注数学边界）：原样返回，尊重用户意图。
 * 2. 按行处理，避免内联 $...$ 跨行（remark-math 内联数学不跨行）。
 * 3. 每行再按 CJK 边界切分：CJK 段保持纯文本（KaTeX 不渲染中文）；
 *    非 CJK 段若含 LaTeX 触发语法则整体包入 $...$，两侧空白留在 $ 外；
 *    纯 ASCII（如 a/b）保持文本不包。
 *
 * 例：\frac{a}{b} -> $\frac{a}{b}$；a/b -> a/b；
 *     因为 x^2 所以 -> 因为 $x^2$ 所以；
 *     x^2和y^2 -> $x^2$和$y^2$
 */
export function autoWrapMath(text: string): string {
  if (text.includes('$')) return text;
  return text
    .split('\n')
    .map(line =>
      line
        .split(CJK_RUN)
        .map(part => {
          if (!part || CJK_CHAR.test(part)) return part; // CJK 段：纯文本
          const lead = part.match(/^\s*/)![0];
          const tail = part.match(/\s*$/)![0];
          const core = part.slice(lead.length, part.length - tail.length);
          if (!core) return part;
          return LATEX_TRIGGER.test(core) ? `${lead}$${core}$${tail}` : part;
        })
        .join(''),
    )
    .join('\n');
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
        <div className="prose prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm, remarkBreaks]} rehypePlugins={[rehypeKatex]}>
            {wrapped}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="text-[var(--text-secondary)] text-sm">预览区（输入后实时渲染）</p>
      )}
    </div>
  );
}
