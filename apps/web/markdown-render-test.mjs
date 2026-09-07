// apps/web/markdown-render-test.mjs
// 验证：用共享模块 markdown.tsx 的配置（remark-math + remark-gfm + rehype-raw +
// rehype-katex + 自定义 img + preprocessMarkdown）渲染用户给的题面，看
// 表格 / \n 字面量 / 数学公式 / 图片 各点是否正确。
//
// 跑法：cd apps/web && node markdown-render-test.mjs
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';

// ── 复刻 apps/web/src/components/markdown.tsx 的核心逻辑 ──
const ASSET_BASE = '/assets/';
const resolveAsset = (p) =>
  /^https?:\/\//.test(p) || p.startsWith('data:') ? p : `${ASSET_BASE}${p.replace(/^\/+/, '')}`;

const TAG_LT_RE = /<([a-zA-Z][a-zA-Z0-9]*)(?=<)/g;
function repairHtml(text) {
  if (!text || !text.includes('<')) return text ?? '';
  return text.replace(TAG_LT_RE, '<$1>');
}
const preprocessMarkdown = (s) => (s ? repairHtml(s.replace(/\\n(?![a-zA-Z])/g, '\n')) : '');

const markdownRemarkPlugins = [remarkMath, remarkGfm];
const markdownRehypePlugins = [rehypeRaw, rehypeKatex];

function MarkdownImg({ src, alt, className }) {
  return React.createElement('img', {
    src: src ? resolveAsset(src) : '',
    alt: alt ?? '',
    className: className ?? 'block mx-auto my-2 max-w-full h-[50px] object-contain rounded-lg',
  });
}
// 复刻共享模块的 table/th/td border 样式（表格线）
const markdownComponents = {
  img: MarkdownImg,
  table: ({ children }) => React.createElement('div', { className: 'my-2 overflow-x-auto' },
    React.createElement('table', { className: 'border-collapse w-full text-sm' }, children)),
  th: ({ children }) => React.createElement('th', { className: 'border border-[var(--bg-subtle)] px-2.5 py-1 text-left font-semibold bg-[var(--bg-base)] align-middle' }, children),
  td: ({ children }) => React.createElement('td', { className: 'border border-[var(--bg-subtle)] px-2.5 py-1 align-middle' }, children),
};

// ── 用户贴的题面原文（DB 存储形式：\n 是字面反斜杠+n，\leq \_ \text 等是字面 LaTeX）──
// 用 String.raw 保留所有字面转义，不解析 \n \leq 等。
const content = String.raw`某学校为了调查该校学生早上从家到校所需的时长，从中随机抽查了 100 名学生，记录了他们早上从家到校的时长（单位：分钟）（整数），并对这 100 个数据进行整理、描述和分析。下面给出了部分信息。

a. 100个数据频数分布直方图（数据分成5组： $0 \leq x < 10$ ， $10 \leq x < 20$ ， $20 \leq x < 30$ ， $30 \leq x < 40$ ， $40 \leq x < 50$ ）\n\n![](questions/math/77d9cc18/23/stem_01.jpg)\n\n b. 时长在 $20 \leqslant x < 30$ 这一组的是:\n\n<table><tr<td>20</td><td>20</td><td>21</td><td>21</td><td>23</td><td>23</td><td>23</td><td>24</td><td>24</td><td>24</td><td>25</td><td>25</td><td>25</td><td>26</td><td>26</td></tr><tr><td>26</td><td>26</td><td>27</td><td>27</td><td>27</td><td>27</td><td>27</td><td>28</td><td>28</td><td>28</td><td>29</td><td>29</td><td>29</td><td>29</td><td>29</td></tr></table>\n\n(1) $m$ 的值为\_ \text{，} 100$ 个数据的中位数是\_ \text{，}$ 平均数约为\_ \text{（用各组的组中值代表各组的数据）；}$\n\n(2)从 $10 \leqslant x < 20$ 中随机选取 15 个数据分成 A, B, C 三组, 每组 5 个数据, 信息如下:\n\n<table><tr<td>A组</td><td>15</td><td>15</td><td>15</td><td>17</td><td>n</td></tr><tr><td>B组</td><td>14</td><td>15</td><td>16</td><td>16</td><td>18</td></tr><tr><td>C组</td><td>13</td><td>17</td><td>18</td><td>18</td><td>19</td></tr></table>\n\n已知 A 组与 B 组的平均数相等.\n\n①n 的值为\_；\n\n②学校从 A, B, C 三组中选出一组到校从事晨检工作, 要求: 先比较平均数, 平均数较小的组排序靠前; 若平均数相等, 再比较方差, 方差较小的组排序靠前. 在 A, B, C 三组的排序中, 排序最靠前的是\_ 组.`;

// ── 跑两遍：A 不调 preprocessMarkdown（看 \n 是否原样显示），B 调（看还原后）──
const processed = preprocessMarkdown(content);

const render = (text) =>
  renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      remarkPlugins: markdownRemarkPlugins,
      rehypePlugins: markdownRehypePlugins,
      components: markdownComponents,
    }, text),
  );

// ── 对比：把残缺的 <tr<td> 修成 <tr><td>，看渲染是否正常 ──
// 现在这步由 preprocessMarkdown 内部的 repairHtml 自动完成（前端兜底）
const contentFixed = content.replace(/<tr</g, '<tr><');

const safe = (label, fn) => {
  try { return { ok: true, html: fn() }; }
  catch (e) { return { ok: false, err: String(e.message || e).slice(0, 200) }; }
};

const rRaw = safe('raw', () => render(content));
const rProcessed = safe('processed', () => render(processed));
const rFixed = safe('fixed', () => render(contentFixed));

// ── 断言 ──
const checks = [
  { name: 'A. 原题面（残缺 HTML <tr<td>）不经 preprocessMarkdown 渲染抛错 / 降级',
    pass: !rRaw.ok && (rRaw.err || '').includes('Invalid tag') },
  { name: 'B. 经 preprocessMarkdown（含 repairHtml）后渲染不报错',
    pass: rProcessed.ok },
  { name: 'C. repairHtml 把 <tr<td> 修成 <tr><td>（processed 不含 <tr<）',
    pass: !processed.includes('<tr<') && !processed.includes('<td<') },
  { name: 'D. HTML 表格被 rehype-raw 解析（输出含 <table）',
    pass: rProcessed.ok && rProcessed.html.includes('<table') },
  { name: 'E. 表格 td 被解析（输出含 <td）',
    pass: rProcessed.ok && rProcessed.html.includes('<td') },
  { name: 'F. 表格线：th/td 带 border class',
    pass: rProcessed.ok && rProcessed.html.includes('border-[var(--bg-subtle)]') },
  { name: 'G. 数学公式被 KaTeX 渲染（输出含 class="katex"）',
    pass: rProcessed.ok && rProcessed.html.includes('katex') },
  { name: 'H. 图片 src 被补 /assets/ 前缀',
    pass: rProcessed.ok && rProcessed.html.includes('/assets/questions/math/77d9cc18/23/stem_01.jpg') },
  { name: 'I. preprocessMarkdown 把 \\n 还原（无字面 \\n 残留）',
    pass: !processed.includes('\\n') },
];

console.log('════════════════════════════════════════════════════════════');
console.log('  preprocessMarkdown 还原 \\n 后的文本（前 300 字）');
console.log('════════════════════════════════════════════════════════════');
console.log(processed.slice(0, 300));
console.log('\n════════════════════════════════════════════════════════════');
console.log('  断言结果');
console.log('════════════════════════════════════════════════════════════');
for (const c of checks) {
  console.log(`${c.pass ? '✓ PASS' : '✗ FAIL'}  ${c.name}`);
}

console.log('\n════════════════════════════════════════════════════════════');
console.log('  原题面（残缺 HTML <tr<td>）不经 preprocessMarkdown 渲染');
console.log('════════════════════════════════════════════════════════════');
if (rRaw.ok) {
  console.log('(没抛错，HTML 前 300 字）：');
  console.log(rRaw.html.slice(0, 300));
} else {
  console.log('✗ 渲染抛错：' + rRaw.err);
  console.log('  → 这就是用户看到「表格没正确绘制」的根因：题面 HTML 残缺（<tr<td> 缺 >），');
  console.log('    rehype-raw 解析出非法 tag 名 tr<td，react-markdown/React 无法渲染。');
}

console.log('\n════════════════════════════════════════════════════════════');
console.log('  经 preprocessMarkdown（含 repairHtml 兜底）渲染');
console.log('════════════════════════════════════════════════════════════');
if (rProcessed.ok) {
  console.log('✓ 渲染成功，HTML 全文：');
  console.log(rProcessed.html);
} else {
  console.log('✗ 仍报错：' + rProcessed.err);
}

