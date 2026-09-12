// apps/web/src/components/business/LatexEditor.test.tsx
// 覆盖数学作答输入框的符号面板插入行为：分类讨论（分段函数）大括号模板能插入、
// 光标落在空位、且插入结果经预览管线渲染不报 KaTeX 错（模板里 $$ 独占行 / 末尾换行
// 这两条约束一旦被改动就会在这里失败）。
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { LatexEditor } from './LatexEditor';
import { autoWrapMath } from './LatexPreview';
import { markdownRemarkPluginsWithBreaks, markdownRehypePlugins, markdownComponents } from '@/components/markdown';

// vitest globals:false 下需手动 cleanup，避免上个用例 DOM 泄漏导致重复命中。
afterEach(() => cleanup());

function renderEditor() {
  function Wrapper() {
    const [value, setValue] = useState('');
    return <LatexEditor value={value} onChange={setValue} />;
  }
  render(<Wrapper />);
  return screen.getByRole('textbox');
}

/** 点符号面板里 label 为 label 的按钮 */
async function clickSymbol(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('button', { name: label }));
}

describe('LatexEditor 符号面板', () => {
  it('插入分类讨论大括号模板：含 cases 环境、无 $0 标记残留', async () => {
    const user = userEvent.setup();
    const ta = renderEditor();

    await clickSymbol(user, '{');

    const value = (ta as HTMLTextAreaElement).value;
    expect(value).toContain('\\begin{cases}');
    expect(value).toContain('\\end{cases}');
    expect(value).not.toContain('$0');
  });

  it('插入后光标落在第一行空位（$0 标记处），不在模板末尾', async () => {
    const user = userEvent.setup();
    const ta = renderEditor();

    await clickSymbol(user, '{');

    const el = ta as HTMLTextAreaElement;
    // 光标在 requestAnimationFrame 里才落位；React 写入 value 后 jsdom 先把
    // selectionStart 放在末尾，所以这里必须等「光标之后是 & 换行」这个目标状态，
    // 不能用 selectionStart > 0 之类的弱条件（末尾也满足）。
    await waitFor(() => expect(el.value.slice(el.selectionStart).startsWith(' & \\')).toBe(true));
    expect(el.selectionStart).toBeGreaterThan(0);
    expect(el.selectionStart).toBeLessThan(el.value.length);
  });

  it('模板经预览管线渲染为 display 公式且不报 KaTeX 错', async () => {
    const user = userEvent.setup();
    const ta = renderEditor();

    await clickSymbol(user, '{');
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={markdownRemarkPluginsWithBreaks}
        rehypePlugins={markdownRehypePlugins}
        components={markdownComponents}
      >
        {autoWrapMath((ta as HTMLTextAreaElement).value)}
      </ReactMarkdown>,
    );

    expect(html).toContain('katex-display');
    expect(html).not.toContain('katex-error');
  });

  it('保留既有 {} 占位规则：\\frac 插入后光标落在花括号内', async () => {
    const user = userEvent.setup();
    const ta = renderEditor();

    await clickSymbol(user, '½');

    const el = ta as HTMLTextAreaElement;
    expect(el.value).toBe('\\frac{}{}');
    await waitFor(() => expect(el.selectionStart).toBe(6));
  });
});
