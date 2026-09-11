// 回归测试：用 paper #15「2026 海淀 初三 模拟二」真实入库的解析内容（questions.explanation），
// 验证 markdown + LaTeX 渲染的归一化：
//   1) `$$` 非独占一行（如 $$\begin{aligned}…）也能渲染为块级 display 公式；
//   2) 内嵌 <svg> 的围栏代码块被解包，渲染成真实图形而非代码文本；
//   3) 归一化不破坏真正的代码区（围栏块 / 行内 code）。
// fixture（paper15.fixtures.ts）直接来自 DB，非手写。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { describe, expect, it } from 'vitest';
import {
  preprocessMarkdown,
  markdownRemarkPlugins,
  markdownRehypePlugins,
  markdownComponents,
} from './markdown';
import { PAPER15 } from './paper15.fixtures';

function render(src: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: markdownRemarkPlugins,
        rehypePlugins: markdownRehypePlugins,
        components: markdownComponents,
      },
      preprocessMarkdown(src),
    ),
  );
}

describe('归一化：$$ 与内嵌 SVG 的渲染', () => {
  it('题17：$$\\begin{aligned}…$$ 渲染为块级 display 公式，无报错、无裸 $$', () => {
    const html = render(PAPER15.q17);
    expect(html).toContain('katex-display');
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('$$');
  });

  it('题19：块级公式 + 后续行内公式均渲染', () => {
    const html = render(PAPER15.q19);
    expect(html).toContain('katex-display');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('$$');
  });

  it('题24：公式渲染且内嵌几何示意 SVG 作为图形渲染（非代码块）', () => {
    const html = render(PAPER15.q24);
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('$$');
    expect(html).toContain('<svg');
    expect(html).not.toContain('&lt;svg');
  });

  it('题26：块级公式 + 几何示意 SVG 均渲染', () => {
    const html = render(PAPER15.q26);
    expect(html).toContain('katex-display');
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('$$');
    expect(html).toContain('<svg');
    expect(html).not.toContain('&lt;svg');
  });

  it('已独占一行的 $$ 仍渲染为 display（不回归）', () => {
    const html = render('文本\n\n$$\nM = 1\n$$\n\n后文');
    expect(html).toContain('katex-display');
  });

  it('归一化不破坏代码区：围栏内与行内 code 的 $$ 保持字面', () => {
    expect(preprocessMarkdown('```\na && b\n$$\n```')).toContain('$$\n');
    expect(preprocessMarkdown('行内 `$$` 字面')).toContain('`$$`');
  });

  it('非 svg 的围栏代码块仍渲染为代码块', () => {
    const html = render('```python\nprint(1)\n```');
    expect(html).toContain('<code');
    expect(html).not.toContain('<svg');
  });
});
