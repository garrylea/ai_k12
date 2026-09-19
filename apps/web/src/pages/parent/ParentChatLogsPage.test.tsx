import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from '@/routes/routeTable';
import {
  getParentChatLogDetail,
  getParentChatLogs,
  getUnreadMessageCount,
  listMyStudents,
  type MyStudentItem,
  type ParentChatLogDetail,
  type ParentChatLogPage,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { useThemeStore } from '@/store/themeStore';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listMyStudents: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getParentChatLogs: vi.fn(),
    getParentChatLogDetail: vi.fn(),
  };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMock = vi.mocked(getUnreadMessageCount);
const getLogsMock = vi.mocked(getParentChatLogs);
const getDetailMock = vi.mocked(getParentChatLogDetail);

const BOY: MyStudentItem = { id: 11, parentId: 3, username: 'xiaoming', name: '小明', age: 13, grade: '初一', schoolLevel: 'junior', isActive: true };

const LIST: ParentChatLogPage = {
  page: 1, pageSize: 20, total: 2,
  items: [
    {
      id: 55, track: 'auxiliary', scene: 'aux_qna', title: '二次函数求最值', subjectId: null,
      createdAt: '2026-09-16T10:00:00.000Z', updatedAt: '2026-09-16T10:05:00.000Z',
      messageCount: 8, blockCount: 2,
    },
    {
      id: 56, track: 'mainline', scene: 'mainline_card', title: '整式的加减', subjectId: 1,
      createdAt: '2026-09-15T10:00:00.000Z', updatedAt: '2026-09-15T10:05:00.000Z',
      messageCount: 4, blockCount: 0,
    },
  ],
};

const DETAIL: ParentChatLogDetail = {
  ...LIST.items[0],
  messages: [
    {
      id: 201, role: 'user', content: '怎么求最值', reasoning: null,
      type: null, model: null, safetyFlag: 0, createdAt: '2026-09-16T10:00:30.000Z',
    },
    {
      id: 202, role: 'assistant', content: '先判断开口方向', reasoning: '开口向上取最小值',
      type: 'socratic', model: 'qwen3.8-max', safetyFlag: 0, createdAt: '2026-09-16T10:01:00.000Z',
    },
    {
      id: 203, role: 'assistant', content: '我是你的学习助手，这个话题课后聊',
      reasoning: null, type: 'block', model: 'qwen3.8-max', safetyFlag: 1,
      createdAt: '2026-09-16T10:02:00.000Z',
    },
  ],
};

function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

function renderAt(path: string) {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'parent');
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const result = render(<RouterProvider router={router} />);
  return { router, ...result };
}

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: 11 });
  listMyStudentsMock.mockReset();
  listMyStudentsMock.mockResolvedValue([BOY]);
  getUnreadMock.mockReset();
  getUnreadMock.mockResolvedValue(0);
  getLogsMock.mockReset();
  getLogsMock.mockResolvedValue(LIST);
  getDetailMock.mockReset();
  getDetailMock.mockResolvedValue(DETAIL);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  useThemeStore.setState({ mode: 'student-day' });
});

describe('ParentChatLogsPage', () => {
  it('按锚点孩子取会话列表，默认无筛选、page=1', async () => {
    renderAt('/parent/chat-logs');

    expect(await screen.findByTestId('chatlog-item-55')).toBeInTheDocument();
    expect(getLogsMock).toHaveBeenCalledWith({ studentId: 11, page: 1 });
  });

  it('blockCount > 0 的会话在列表里标红', async () => {
    renderAt('/parent/chat-logs');

    expect(await screen.findByTestId('chatlog-block-badge-55')).toBeInTheDocument();
    expect(screen.queryByTestId('chatlog-block-badge-56')).not.toBeInTheDocument();
  });

  it('点会话 → 拉详情并逐句渲染；block 消息红色标记 + reasoning 折叠', async () => {
    renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');

    fireEvent.click(screen.getByTestId('chatlog-item-55'));

    expect(await screen.findByTestId('chatlog-message-203')).toHaveTextContent('闲聊/偏离学习');
    // reasoning 默认折叠
    expect(screen.queryByTestId('chatlog-reasoning-202')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /看 AI 思路/ }));
    expect(screen.getByTestId('chatlog-reasoning-202')).toHaveTextContent('开口向上取最小值');
  });

  it('AI 回复走共享渲染：$..$ 出 KaTeX、原生 HTML 表格成为真表格、无 katex-error', async () => {
    getDetailMock.mockResolvedValue({
      ...DETAIL,
      messages: [
        {
          ...DETAIL.messages[1],
          // 表格独占一行（前后空行）→ 块级 HTML，避免 <table> 嵌进 <p> 的非法嵌套
          content: '抛物线 $y=x^2$ 的顶点\n\n<table><tr><th>a</th><td>1</td></tr></table>',
          reasoning: null,
        },
      ],
    });

    const { container } = renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');
    fireEvent.click(screen.getByTestId('chatlog-item-55'));

    const row = await screen.findByTestId('chatlog-message-202');
    expect(container.innerHTML).toContain('class="katex"');
    expect(container.innerHTML).not.toContain('katex-error');
    expect(row.querySelector('table')).not.toBeNull();
    expect(row).not.toHaveTextContent('<table>');
  });

  it('孩子的话原样显示（不走 markdown）——与学生端辅线答疑一致，`2*3*4` 不被吃成斜体', async () => {
    getDetailMock.mockResolvedValue({
      ...DETAIL,
      messages: [{ ...DETAIL.messages[0], content: '2*3*4 等于多少', reasoning: null }],
    });

    renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');
    fireEvent.click(screen.getByTestId('chatlog-item-55'));

    const row = await screen.findByTestId('chatlog-message-201');
    expect(row).toHaveTextContent('2*3*4 等于多少');
    // 若孩子的话被当 markdown 渲染，`*3*` 会变成 <em>
    expect(row.querySelector('em')).toBeNull();
  });

  it('AI 思路走 markdown（公式渲染，且保留换行）', async () => {
    getDetailMock.mockResolvedValue({
      ...DETAIL,
      messages: [{ ...DETAIL.messages[1], content: '见下', reasoning: '两边同时除 $2$' }],
    });

    const { container } = renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');
    fireEvent.click(screen.getByTestId('chatlog-item-55'));
    await screen.findByTestId('chatlog-message-202');

    fireEvent.click(screen.getByRole('button', { name: /看 AI 思路/ }));
    const reasoning = screen.getByTestId('chatlog-reasoning-202');
    expect(reasoning.innerHTML).toContain('class="katex"');
    expect(reasoning).toHaveTextContent('两边同时除');
    expect(container.innerHTML).not.toContain('katex-error');
  });

  it('轨道筛选透传（选辅线答疑）', async () => {
    renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');

    fireEvent.change(screen.getByLabelText('轨道'), { target: { value: 'auxiliary' } });

    await waitFor(() =>
      expect(getLogsMock).toHaveBeenLastCalledWith({ studentId: 11, track: 'auxiliary', page: 1 }),
    );
  });

  it('关键词搜索只搜标题（传 q）', async () => {
    renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');

    fireEvent.change(screen.getByLabelText('搜索会话标题'), { target: { value: '函数' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));

    await waitFor(() =>
      expect(getLogsMock).toHaveBeenLastCalledWith({ studentId: 11, q: '函数', page: 1 }),
    );
  });

  it('空数据 → 空态，右侧显示「选择一条对话」', async () => {
    getLogsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    renderAt('/parent/chat-logs');

    expect(await screen.findByTestId('chatlogs-empty')).toBeInTheDocument();
    expect(screen.getByTestId('chatlog-detail-placeholder')).toBeInTheDocument();
  });

  it('没有选孩子 → 空态，不发请求', async () => {
    // 必须让切换器拿到**空列表**：否则它会把锚点回落成第一个孩子，页面就开始取数了
    useParentStudentStore.setState({ studentId: null });
    listMyStudentsMock.mockResolvedValue([]);

    renderAt('/parent/chat-logs');

    expect(await screen.findByTestId('chatlogs-no-student')).toBeInTheDocument();
    expect(getLogsMock).not.toHaveBeenCalled();
  });

  it('切换孩子时，上一个孩子的对话内容不能留在右侧（详情必须按 studentId 归属）', async () => {
    const GIRL = { ...BOY, id: 12, username: 'xiaomei', name: '小美' };
    listMyStudentsMock.mockResolvedValue([BOY, GIRL]);

    renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');
    fireEvent.click(screen.getByTestId('chatlog-item-55'));
    expect(await screen.findByTestId('chatlog-message-201')).toBeInTheDocument();

    // 切到小美，并让「详情」请求悬着不 resolve —— 此时旧内容**不能**还挂在屏上。
    // 本页不会因换孩子而重挂载（ParentLayout 的 <Outlet/> 没有 key），
    // 所以只按 activeId 守卫会让上一个孩子的整段对话在新孩子的名字下继续显示。
    getDetailMock.mockImplementation(() => new Promise(() => {}));
    act(() => useParentStudentStore.setState({ studentId: GIRL.id }));

    await waitFor(() =>
      expect(screen.queryByTestId('chatlog-message-201')).not.toBeInTheDocument(),
    );
  });

  it('切孩子后旧会话在新孩子下请求失败，也不能停在失败态（失败标记必须带归属）', async () => {
    const GIRL = { ...BOY, id: 12, username: 'xiaomei', name: '小美' };
    listMyStudentsMock.mockResolvedValue([BOY, GIRL]);

    renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');
    fireEvent.click(screen.getByTestId('chatlog-item-55'));
    expect(await screen.findByTestId('chatlog-message-201')).toBeInTheDocument();

    // 切到小美后，activeId 仍是老会话 55 → 会发 (12, 55)，这个组合本就不存在 → 必然失败
    getDetailMock.mockRejectedValue(new Error('1002'));

    act(() => useParentStudentStore.setState({ studentId: GIRL.id }));

    await waitFor(() => expect(getDetailMock).toHaveBeenCalledWith(GIRL.id, 55));
    // 不能把「上一个孩子留下的选中会话」的失败，当成新孩子的详情失败态停在右侧
    await waitFor(() =>
      expect(screen.queryByText('这条对话暂时无法查看')).not.toBeInTheDocument(),
    );
  });

  // ↓↓↓ 三条守卫的真实钉子（删掉实现里的守卫它们会红，见 report 反向证据） ↓↓↓

  it('翻页后改筛选 → 回到第 1 页（changeFilter）', async () => {
    getLogsMock.mockResolvedValue({ ...LIST, total: 40 });

    renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() =>
      expect(getLogsMock).toHaveBeenLastCalledWith({ studentId: 11, page: 2 }),
    );

    fireEvent.change(screen.getByLabelText('轨道'), { target: { value: 'mainline' } });

    await waitFor(() =>
      expect(getLogsMock).toHaveBeenLastCalledWith({ studentId: 11, track: 'mainline', page: 1 }),
    );
  });

  it('响应自报的 page 与当前页不符 → 不渲染该响应（自报家门守卫）', async () => {
    getLogsMock.mockImplementation(async (params) => {
      if (params.page === 2) {
        // 后端回显 page=1（自报家门对不上），页面必须把它当「还没到货」
        return {
          ...LIST,
          page: 1,
          total: 40,
          items: [{ ...LIST.items[1], id: 57, title: '不该出现的第二页会话' }],
        };
      }
      return { ...LIST, total: 40 };
    });

    renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() =>
      expect(getLogsMock).toHaveBeenLastCalledWith({ studentId: 11, page: 2 }),
    );

    expect(await screen.findByTestId('chatlogs-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('chatlog-item-57')).not.toBeInTheDocument();
  });

  it('切会话时上一条详情不闪现（activeId 守卫）', async () => {
    // 用对象属性而非局部变量持有 resolve：TS 的控制流分析会把「只在闭包里赋值」的
    // 局部变量在调用点收窄成 never（build 报 TS2349）。
    const second: { resolve: (value: ParentChatLogDetail) => void } = {
      resolve: () => {},
    };
    getDetailMock.mockImplementation((_studentId, dialogueId) => {
      if (dialogueId === 56) {
        return new Promise<ParentChatLogDetail>((resolve) => {
          second.resolve = resolve;
        });
      }
      return Promise.resolve(DETAIL);
    });

    renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');
    fireEvent.click(screen.getByTestId('chatlog-item-55'));
    await screen.findByTestId('chatlog-message-203');

    fireEvent.click(screen.getByTestId('chatlog-item-56'));
    await waitFor(() => expect(getDetailMock).toHaveBeenLastCalledWith(11, 56));

    // 56 的详情还在路上，state 里仍是 55 的详情 → 守卫必须拦住，不能挂在 56 下面
    expect(screen.queryByTestId('chatlog-message-203')).not.toBeInTheDocument();

    second.resolve({
      ...LIST.items[1],
      messages: [
        {
          id: 301, role: 'user', content: '第二条会话的消息', reasoning: null,
          type: null, model: null, safetyFlag: 0, createdAt: '2026-09-15T10:00:10.000Z',
        },
      ],
    });
    expect(await screen.findByTestId('chatlog-message-301')).toBeInTheDocument();
    expect(screen.queryByTestId('chatlog-message-203')).not.toBeInTheDocument();
  });
});

describe('路由清理', () => {
  it('/parent/children-switch 已从路由表删除（顶栏 StudentSwitcher 是真实实现）', () => {
    // 直接查路由表，而不是渲染该路径再看 404 兜底——后者依赖 react-router 的错误渲染行为，
    // 断言会很脆。这里要钉的是「这条路由不存在了」。
    const parentRoute = routes.find((r) => r.path === '/parent');
    const childPaths = (parentRoute?.children ?? []).map((c) => c.path);
    expect(childPaths).not.toContain('children-switch');
  });
});
