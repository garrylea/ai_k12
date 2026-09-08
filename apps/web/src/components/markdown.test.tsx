// 回归测试：块级 HTML（<table> 等）之后的 markdown + LaTeX 必须继续按 markdown 渲染。
// 背景：CommonMark 把「行首块级 HTML 标签」当 HTML 块一直吃到下一个空行。LLM 生成的
// 题面常在 </table> 后直接接 markdown 段落（无空行），导致后续内容全被吞进同一个 raw
// html 节点，rehype-raw 把它当普通文本输出（<p>/<strong>/KaTeX 全丢）。
//
// 用 react-dom/server 渲染真实的 ReactMarkdown + markdown.tsx 导出的 plugins/components，
// 对渲染出的 HTML 字符串做断言（不依赖浏览器）。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { describe, expect, it } from 'vitest';
import {
  preprocessMarkdown,
  markdownRemarkPlugins,
  markdownRemarkPluginsWithBreaks,
  markdownRehypePlugins,
  markdownComponents,
} from './markdown';

function render(src: string, opts?: { breaks?: boolean }): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: opts?.breaks ? markdownRemarkPluginsWithBreaks : markdownRemarkPlugins,
        rehypePlugins: markdownRehypePlugins,
        components: markdownComponents,
      },
      preprocessMarkdown(src),
    ),
  );
}

// 用户报告的题面：第二个表格是原生 HTML，其后紧跟 markdown + LaTeX（无空行）。
const REPORTED_CONTENT = `某旅游城市的居民王先生利用自有房屋开设一家具有当地民俗文化特色的民宿, 改造完成后于 2025 年 3 月初开始营业. 截至 2026 年 2 月底, 共计经营时长为 12 个月, 民宿营业收入累计额如下表所示（注：原题为图象，此处补充关键数据点以支持计算）：
| 经营时长(月) | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 营业收入累计额(万元) | 0 | 15 | 38 | 60 | 85 | 110 | 135 | 160 | 185 | 210 | 235 | 260 | 285 |

民宿的利润等于营业收入减去支出费用。支出费用包含两部分，一部分是民宿的改造费，共计30万元，开业前已支付完毕；另一部分是除改造费之外的其它支出费用，这部分费用按月累计数据如下：
<table><tr><td>经营时长(月)</td><td>0</td><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td><td>7</td><td>8</td><td>9</td><td>10</td><td>11</td><td>12</td></tr><tr><td>其它支出费用累计额(万元)</td><td>0</td><td>18</td><td>25</td><td>30</td><td>42</td><td>55</td><td>68</td><td>80</td><td>92</td><td>102</td><td>113</td><td>125</td><td>137</td></tr></table>
结合上述信息，回答下列问题：
(1) 王先生的民宿在 2025 年 3 月初到 2026 年 2 月底这 12 个月的经营中,
①第2个月的其它支出费用为\\_\\_\\_\\_万元；
②单月营业收入最高的是第\\_\\_\\_\\_个月(填整数)；
(2) ① 在上面的坐标系中画出其它支出费用累计额关于经营时长的图象;
②根据图象估计王先生的民宿自开始营业后第\\_\\_\\_\\_个月开始盈利(填整数)；
(3) “累计成本利润率 (记为 $M$ )”是指经营项目在一定时期内, 累计实现的盈利总额与同期累计发生的支出总额的比值.
$$
M = \\frac {\\mathrm{累计盈利总额}}{\\mathrm{累计支出总额}} \\times 1 0 0
$$
根据该城市的行业评价标准，当 $30\\% \\leqslant M < 50\\%$ 时，可评定为经营效果良好并能被当地文旅部门优先推介。若累计盈利总额和累计支出总额(含改造费)从开始营业时计算，则王先生的民宿首次被评定为经营效果良好是第 \\_\\_\\_\\_ 个月(填整数)。`;

describe('markdown 块级 HTML 后的内容渲染', () => {
  it('原生 HTML 表格之后的 markdown + LaTeX 正常渲染（用户报告的场景）', () => {
    const html = render(REPORTED_CONTENT);

    // 两张表格都渲染（GFM 表格 + 原生 HTML 表格）
    expect(html).toContain('<table');
    expect(html).toContain('其它支出费用累计额(万元)');

    // 【核心】HTML 表格后的正文必须按 markdown 段落渲染，而非裸文本
    expect(html).toContain('<p>结合上述信息，回答下列问题：');

    // 【核心】表格后的行内公式 $M$ 渲染为 KaTeX
    expect(html).toContain('class="katex"');

    // 【核心】表格后的 $$ 块级公式渲染为 KaTeX 块
    expect(html).toContain('class="katex-display"');

    // 【核心】表格后的 \_\_\_\_ 转义仍生效（还原为字面下划线）
    expect(html).toContain('____万元');
  });

  it('无 HTML 内容的普通 markdown 不受影响', () => {
    const html = render('第一段\n\n第二段 $x^2$ 与 **粗体**');
    expect(html).toContain('<p>第一段</p>');
    expect(html).toContain('class="katex"');
    expect(html).toContain('<strong>粗体</strong>');
  });

  it('段落内联 HTML 不受影响', () => {
    const html = render('正文中有 <b>粗体</b> 和 $M$ 公式');
    expect(html).toContain('<b>粗体</b>');
    expect(html).toContain('class="katex"');
  });

  it('多行 HTML 块（div 内含文本）不被误切分', () => {
    const html = render('<div class="wrap">\n<p>content</p>\n</div>');
    // div 整体保留为 HTML，而非把内部文本切成 markdown
    expect(html).toContain('<div class="wrap">');
    expect(html).toContain('<p>content</p>');
  });

  it('HTML 块后接空行时正常渲染（原本就能工作的场景不回归）', () => {
    const html = render('<table><tr><td>a</td></tr></table>\n\n后文 $M$');
    expect(html).toContain('<p>后文');
    expect(html).toContain('class="katex"');
  });
});
