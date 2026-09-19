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
