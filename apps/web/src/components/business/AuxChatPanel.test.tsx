import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AuxChatPanel from './AuxChatPanel';
import { useChatStore } from '@/store/chatStore';

// jsdom 不实现 scrollIntoView，而本组件挂载/更新时会滚到底部
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// globals: false —— 本仓不自动注册 RTL 的 cleanup，多用例文件必须自己收
afterEach(() => {
  cleanup();
  useChatStore.setState({ messages: [], isStreaming: false });
});

describe('AuxChatPanel：历史消息里的图片', () => {
  it('图片渲染成 <img>（原样用 /uploads 路径），点击开大图、Esc 关闭', async () => {
    useChatStore.setState({
      messages: [
        { id: 13, role: 'user', content: '这道题怎么做', images: ['/uploads/auxiliary/a.jpg'] },
      ],
      isStreaming: false,
    });

    render(<AuxChatPanel />);

    const img = screen.getByAltText('已发送图片');
    expect(img).toHaveAttribute('src', '/uploads/auxiliary/a.jpg');

    fireEvent.click(img);
    expect(await screen.findByTestId('image-lightbox')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('image-lightbox')).not.toBeInTheDocument());
  });

  it('AI 回复走 markdown，孩子的话原样（图片区并存）', () => {
    useChatStore.setState({
      messages: [
        { id: 201, role: 'user', content: '2*3*4 等于多少', images: ['/uploads/auxiliary/a.jpg'] },
        { id: 202, role: 'assistant', content: '等于 $24$' },
      ],
      isStreaming: false,
    });

    const { container } = render(<AuxChatPanel />);

    expect(container.innerHTML).toContain('class="katex"');
    expect(screen.getByAltText('已发送图片')).toBeInTheDocument();
    // 孩子的话不被当 markdown 渲染（`*3*` 若被吃会变成 <em>）
    expect(screen.getByText('2*3*4 等于多少').querySelector('em')).toBeNull();
  });
});

describe('AuxChatPanel：Markdown 用户消息（自由答疑）', () => {
  it('markdown=true 的用户消息按 Markdown 渲染', () => {
    useChatStore.setState({
      messages: [
        { role: 'user', content: '答案是 $x=1$', markdown: true },
      ],
      isStreaming: false,
    });
    const { container } = render(<AuxChatPanel />);
    expect(container.querySelector('.katex')).toBeTruthy();
  });

  it('默认用户消息仍是纯文本', () => {
    useChatStore.setState({ messages: [{ role: 'user', content: '$x=1$' }], isStreaming: false });
    const { container } = render(<AuxChatPanel />);
    expect(container.querySelector('.katex')).toBeNull();
  });
});

describe('AuxChatPanel：富文本渲染契约', () => {
  it('标准 LaTeX 定界符、内联 SVG、HTML 表格都能渲染', () => {
    const svg =
      '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" stroke="currentColor" fill="none" /></svg>';
    useChatStore.setState({
      messages: [
        {
          role: 'assistant',
          content: `面积 \\[ S=\\pi r^2 \\]\n\n${svg}\n\n<table><tbody><tr><td>甲</td><td>乙</td></tr></tbody></table>`,
        },
      ],
      isStreaming: false,
    });

    const { container } = render(<AuxChatPanel />);

    // \[…\] 被归一为 $$…$$ 后由 KaTeX 出块级公式
    expect(container.querySelector('.katex-display')).toBeTruthy();
    // 原生 <svg> 不能被转义成文本
    expect(container.querySelector('svg circle')).toBeTruthy();
    // HTML 表格照常渲染
    expect(container.querySelector('table td')?.textContent).toBe('甲');
  });

  it('```svg 围栏会解包成真实 SVG，而不是代码块', () => {
    useChatStore.setState({
      messages: [
        {
          role: 'assistant',
          content: '```svg\n<svg viewBox="0 0 10 10"><rect width="10" height="10" /></svg>\n```',
        },
      ],
      isStreaming: false,
    });

    const { container } = render(<AuxChatPanel />);

    expect(container.querySelector('svg rect')).toBeTruthy();
    expect(container.querySelector('pre code')).toBeNull();
  });
});
