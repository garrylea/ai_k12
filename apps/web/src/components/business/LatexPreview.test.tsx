// apps/web/src/components/business/LatexPreview.test.tsx
// 覆盖 autoWrapMath 的「裸文本自动补 $...$」判定：
// 1) 混用场景的回归——第一行裸 \triangle + 第二行 $x=1$ 时，前者必须仍然渲染（曾经因
//    整段 text.includes('$') 短路而退化成字面文本）；
// 2) 数学符号触发（+ - * / = 等）；
// 3) 不误伤的边界（Markdown 结构行 / 英文单词 / TeX 特殊字符 / 行内代码 / 未配对 $）。
// 另覆盖滚动跟随：scrollSync 通道（输入区写入比例 → 预览区按自身高度比例定位 scrollTop）。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { LatexPreview, autoWrapMath } from './LatexPreview';
import type { PreviewScrollSync } from './preview-scroll-sync';
import { markdownRemarkPluginsWithBreaks, markdownRehypePlugins, markdownComponents } from '@/components/markdown';

afterEach(() => cleanup());

/** jsdom 无布局：用实例属性覆写滚动几何，返回可断言的 scrollTop 视图 */
function mockScrollGeometry(el: HTMLElement, geo: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  let top = geo.scrollTop;
  Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = v; }, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { get: () => geo.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => geo.clientHeight, configurable: true });
  return { get scrollTop() { return top; } };
}

/** 走与 LatexPreview 完全相同的渲染管线，拿到 HTML 断言（含 KaTeX 报错检测）。 */
const renderPreview = (s: string) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={markdownRemarkPluginsWithBreaks}
      rehypePlugins={markdownRehypePlugins}
      components={markdownComponents}
    >
      {autoWrapMath(s)}
    </ReactMarkdown>,
  );

/** KaTeX 每个公式输出 `<span class="katex">` 外层 + `<span class="katex-html">` 内层，只数外层。 */
const katexCount = (html: string) => (html.match(/class="katex"/g) ?? []).length;

describe('autoWrapMath 补 $ 判定', () => {
  it('裸 LaTeX 命令照旧自动包 $', () => {
    expect(autoWrapMath('\\triangle')).toBe('$\\triangle$');
    expect(autoWrapMath('\\frac{a}{b}')).toBe('$\\frac{a}{b}$');
  });

  it('已显式写的 $...$ 原样保留', () => {
    expect(autoWrapMath('$x=1$')).toBe('$x=1$');
    expect(autoWrapMath('$$x=1$$')).toBe('$$x=1$$');
  });

  it('含 + - * / = 的裸数学式自动包 $', () => {
    expect(autoWrapMath('a+b=1')).toBe('$a+b=1$');
    expect(autoWrapMath('x-1')).toBe('$x-1$');
    expect(autoWrapMath('1/2')).toBe('$1/2$');
    expect(autoWrapMath('2*3=6')).toBe('$2*3=6$');
    expect(autoWrapMath('x>0')).toBe('$x>0$');
  });

  it('CJK 段留在数学模式外，非 CJK 段各自包 $', () => {
    expect(autoWrapMath('因为 x^2 所以')).toBe('因为 $x^2$ 所以');
    expect(autoWrapMath('因为a+b=1所以')).toBe('因为$a+b=1$所以');
  });

  it('行内代码 / 围栏代码块 / $$ 块原样保留，不参与自动补 $', () => {
    expect(autoWrapMath('`a+b=1`')).toBe('`a+b=1`');
    expect(autoWrapMath('```\na+b=1\n```')).toBe('```\na+b=1\n```');
    expect(autoWrapMath('$$\\begin{cases}a & x>0\\end{cases}$$')).toBe('$$\\begin{cases}a & x>0\\end{cases}$$');
  });

  // ── 本次修复的核心理由：判定逐段做，一处 $ 不再让全篇失效 ──
  it('裸 \\triangle 与下一行的 $x=1$ 共存时，前者仍自动包 $', () => {
    expect(autoWrapMath('\\triangle\n$x=1$')).toBe('$\\triangle$\n$x=1$');
  });

  it('自动补的 $ 紧贴用户写的 $ 时补空格隔开，避免连成 $$', () => {
    // 实测 $\triangle$$x=1$ 会被 remark-math 当成单个公式、KaTeX 渲染报错
    expect(autoWrapMath('\\triangle$x=1$')).toBe('$\\triangle$ $x=1$');
    expect(autoWrapMath('$x=1$a+b=1')).toBe('$x=1$ $a+b=1$');
  });

  it('未配对的 $（打字中）所在段保持原样，其它行照常处理', () => {
    expect(autoWrapMath('\\triangle $\na+b=1')).toBe('\\triangle $\n$a+b=1$');
  });

  // ── 不误伤的边界 ──
  it('Markdown 结构记号不当数学（列表 / 有序列表 / 标题）', () => {
    expect(autoWrapMath('- 第一问')).toBe('- 第一问');
    expect(autoWrapMath('1. 第一问')).toBe('1. 第一问');
    expect(autoWrapMath('# 标题')).toBe('# 标题');
    expect(autoWrapMath('---')).toBe('---');
  });

  it('Markdown 结构行里的公式仍要渲染：只剥掉记号，正文照常判定', () => {
    expect(autoWrapMath('- x^2')).toBe('- $x^2$');
    expect(autoWrapMath('1. x^2')).toBe('1. $x^2$');
    expect(autoWrapMath('## x^2')).toBe('## $x^2$');
    expect(autoWrapMath('> x^2')).toBe('> $x^2$');
    expect(autoWrapMath('- a+b=1')).toBe('- $a+b=1$');
  });

  it('表格行按单元格判定，竖线保留', () => {
    expect(autoWrapMath('| a-b | 1 |')).toBe('| $a-b$ | 1 |');
    expect(autoWrapMath('|---|---|')).toBe('|---|---|');
  });

  it('行内 Markdown（删除线 / 链接 / 图片 / 强调）不包，语法不被吞进公式', () => {
    expect(autoWrapMath('~~a-b~~')).toBe('~~a-b~~');
    expect(autoWrapMath('[点我](a-b)')).toBe('[点我](a-b)');
    expect(autoWrapMath('![图](a-b.png)')).toBe('![图](a-b.png)');
    expect(autoWrapMath('*x^2*')).toBe('*x^2*');
  });

  it('HTML 标签不包（< > 是数学触发符，但标签要交给 rehype-raw）', () => {
    expect(autoWrapMath('<tr>')).toBe('<tr>');
    expect(autoWrapMath('</td>')).toBe('</td>');
    expect(autoWrapMath('<br/>')).toBe('<br/>');
    expect(autoWrapMath('<td>1</td>')).toBe('<td>1</td>');
  });

  it('段中的 < > 仍按数学判定（只有段首的尖括号才算标签）', () => {
    expect(autoWrapMath('a<b')).toBe('$a<b$');
    expect(autoWrapMath('x>0')).toBe('$x>0$');
    expect(autoWrapMath('a<=b')).toBe('$a<=b$');
  });

  it('含英文单词的段不当数学', () => {
    expect(autoWrapMath('error-level')).toBe('error-level');
    expect(autoWrapMath('and/or')).toBe('and/or');
    expect(autoWrapMath('sin x')).toBe('sin x');
  });

  it('TeX 特殊字符段不包（% 会被当注释吞掉、# & 会报错）', () => {
    expect(autoWrapMath('a=50%')).toBe('a=50%');
    expect(autoWrapMath('a&b=1')).toBe('a&b=1');
  });

  it('Markdown 加粗不处理，单独的符号段不当公式', () => {
    expect(autoWrapMath('**答案**')).toBe('**答案**');
    expect(autoWrapMath('*')).toBe('*');
    expect(autoWrapMath('/')).toBe('/');
  });
});

describe('autoWrapMath 渲染结果', () => {
  it('混用两行：都渲染成公式，且无 KaTeX 报错', () => {
    const html = renderPreview('\\triangle\n$x=1$');
    expect(katexCount(html)).toBe(2);
    expect(html).not.toContain('katex-error');
    expect(html).toContain('△'); // \triangle 真的渲染成了三角形
  });

  it('裸 a+b=1 与 $a+b=1$ 渲染结果一致', () => {
    const bare = renderPreview('a+b=1');
    const wrapped = renderPreview('$a+b=1$');
    expect(katexCount(bare)).toBe(1);
    expect(bare).toBe(wrapped);
    expect(bare).not.toContain('katex-error');
  });

  it('相邻 $ 补空格后仍是两个公式而非一个报错公式', () => {
    const html = renderPreview('\\triangle$x=1$');
    expect(katexCount(html)).toBe(2);
    expect(html).not.toContain('katex-error');
  });

  // ── Markdown 结构必须保住，同时结构里的公式也要渲染 ──
  it('标题里的公式：渲染成 h2 且含 KaTeX（旧实现会整行包 $ 变成 KaTeX 报错）', () => {
    const html = renderPreview('## x^2');
    expect(html).toContain('<h2>');
    expect(katexCount(html)).toBe(1);
    expect(html).not.toContain('katex-error');
  });

  it('列表 / 引用里的公式：结构保住且含 KaTeX', () => {
    const ul = renderPreview('- x^2');
    expect(ul).toContain('<ul>');
    expect(katexCount(ul)).toBe(1);
    const quote = renderPreview('> x^2');
    expect(quote).toContain('<blockquote>');
    expect(katexCount(quote)).toBe(1);
  });

  it('表格里的公式：仍是表格且含 KaTeX', () => {
    const html = renderPreview('| 项 | 值 |\n|---|---|\n| a-b | 1 |');
    expect(html).toContain('<table');
    expect(html).toContain('<td');
    expect(katexCount(html)).toBe(1);
  });

  it('行内 Markdown 不被破坏：链接 / 删除线 / 强调', () => {
    expect(renderPreview('[点我](a-b)')).toContain('<a href="a-b">');
    expect(renderPreview('~~a-b~~')).toContain('<del>');
    expect(renderPreview('*x^2*')).toContain('<em>');
  });

  it('HTML 元素正常渲染，不被包成公式', () => {
    // < > 是数学触发符，但段首的尖括号是 HTML 标签，必须留给 rehype-raw
    const row = renderPreview('<tr>');
    expect(katexCount(row)).toBe(0);
    expect(row).toContain('<tr');
    const table = renderPreview('<table><tr><td>a-b</td></tr></table>');
    expect(table).toContain('<table');
    expect(table).toContain('<td');
    expect(katexCount(table)).toBe(0);
  });
});

describe('LatexPreview 滚动跟随（scrollSync 通道）', () => {
  it('挂载后注册 apply：按预览自身滚动高度比例定位 scrollTop', () => {
    const sync: { current: PreviewScrollSync } = { current: { ratio: 0.5 } };
    render(<LatexPreview value="x^2" scrollSync={sync} />);
    expect(sync.current.apply).toBeTypeOf('function');

    const el = screen.getByTestId('latex-preview-scroll');
    const geo = mockScrollGeometry(el, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });

    sync.current.apply!();
    expect(geo.scrollTop).toBe(300); // 0.5 × (1000 - 400)
  });

  it('预览不可滚动时 apply 不动 scrollTop（max<=0 无跟随语义）', () => {
    const sync: { current: PreviewScrollSync } = { current: { ratio: 0.5 } };
    render(<LatexPreview value="x^2" scrollSync={sync} />);
    const el = screen.getByTestId('latex-preview-scroll');
    const geo = mockScrollGeometry(el, { scrollTop: 40, scrollHeight: 400, clientHeight: 400 });

    sync.current.apply!();
    expect(geo.scrollTop).toBe(40);
  });

  it('内容防抖重渲染后按最新比例重定位（渲染高度变了要重放）', async () => {
    const sync: { current: PreviewScrollSync } = { current: { ratio: 0.25 } };
    const view = render(<LatexPreview value="a" scrollSync={sync} />);
    const el = screen.getByTestId('latex-preview-scroll');
    const geo = mockScrollGeometry(el, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });

    sync.current.ratio = 0.75;
    view.rerender(<LatexPreview value="b+c" scrollSync={sync} />);
    await waitFor(() => expect(geo.scrollTop).toBe(450)); // 0.75 × 600，防抖后重放
  });

  it('卸载时注销 apply（tab 切到草稿后输入区滚动不得打到旧节点）', () => {
    const sync: { current: PreviewScrollSync } = { current: { ratio: 0 } };
    const view = render(<LatexPreview value="x^2" scrollSync={sync} />);
    expect(sync.current.apply).toBeTypeOf('function');
    view.unmount();
    expect(sync.current.apply).toBeUndefined();
  });
});
