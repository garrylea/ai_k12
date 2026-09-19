import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from '@/routes/routeTable';
import {
  fetchSubjects,
  getParentErrors,
  getUnreadMessageCount,
  listMyStudents,
  type MyStudentItem,
  type ParentErrorPage,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { useThemeStore } from '@/store/themeStore';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listMyStudents: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getParentErrors: vi.fn(),
    fetchSubjects: vi.fn(),
  };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMock = vi.mocked(getUnreadMessageCount);
const getErrorsMock = vi.mocked(getParentErrors);
const fetchSubjectsMock = vi.mocked(fetchSubjects);

const BOY: MyStudentItem = { id: 11, parentId: 3, username: 'xiaoming', name: '小明', age: 13, grade: '初一', schoolLevel: 'junior', isActive: true };

const PAGE: ParentErrorPage = {
  page: 1, pageSize: 20, total: 21,
  items: [
    {
      // wrongAnswerText 为 null 是**生产不变量**：它只在 questionId 为 null（题库未命中）时
      // 才存一份题面兜底，命中题库时恒为 null（见 judge-core.service.ts 的写入表达式）。
      id: 91, questionId: 330, track: 'main', source: 'exam', level: 2, isCleared: false,
      wrongAnswerText: null, createdAt: '2026-09-16T19:21:00.000Z', clearedAt: null,
      question: {
        content: '解方程 2x+1=7', type: 'calculation', difficulty: 3,
        knowledgePoints: [{ id: 42, name: '分数加减' }],
      },
    },
    {
      id: 92, questionId: null, track: 'training', source: 'auxiliary', level: 1, isCleared: true,
      wrongAnswerText: '只存了题面', createdAt: '2026-09-15T19:21:00.000Z',
      clearedAt: '2026-09-16T09:00:00.000Z', question: null,
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
  getErrorsMock.mockReset();
  getErrorsMock.mockResolvedValue(PAGE);
  fetchSubjectsMock.mockReset();
  fetchSubjectsMock.mockResolvedValue([
    { id: 1, name: '数学', code: 'math', gradeBands: ['junior'] },
    { id: 2, name: '语文', code: 'chinese', gradeBands: ['junior'] },
  ]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  useThemeStore.setState({ mode: 'student-day' });
});

describe('ParentErrorsPage', () => {
  it('按锚点孩子取错题，默认 track=main、page=1', async () => {
    renderAt('/parent/errors');

    expect(await screen.findByTestId('error-row-91')).toBeInTheDocument();
    expect(getErrorsMock).toHaveBeenCalledWith({ studentId: 11, track: 'main', page: 1 });
  });

  it('展开行显示题干/题型/知识点；question 为 null 的行把兜底文本当题面显示', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    fireEvent.click(within(screen.getByTestId('error-row-91')).getByRole('button', { name: /展开/ }));
    expect(screen.getByTestId('error-detail-91')).toHaveTextContent('解方程 2x+1=7');
    expect(screen.getByTestId('error-detail-91')).toHaveTextContent('分数加减');

    fireEvent.click(screen.getByRole('tab', { name: '训练' }));
    await screen.findByTestId('error-row-92');
    fireEvent.click(within(screen.getByTestId('error-row-92')).getByRole('button', { name: /展开/ }));
    expect(screen.getByTestId('error-detail-92')).toHaveTextContent('只存了题面');
    expect(screen.getByTestId('error-detail-92')).toHaveTextContent('题目未入库');
  });

  it('不再出现「学生作答」行——库里从没存过孩子的作答文本', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    fireEvent.click(within(screen.getByTestId('error-row-91')).getByRole('button', { name: /展开/ }));
    expect(screen.getByTestId('error-detail-91')).not.toHaveTextContent('学生作答');
    // 也绝不能出现「（空）」这种把「没有这个字段」显示成「孩子什么都没写」的文案
    expect(screen.getByTestId('error-detail-91')).not.toHaveTextContent('（空）');
  });

  it('题面走共享渲染：$..$ 出 KaTeX、原生 HTML 表格成为真表格、无 katex-error', async () => {
    getErrorsMock.mockResolvedValue({
      ...PAGE,
      items: [
        {
          ...PAGE.items[0],
          question: {
            // 表格独占一行（前后空行）→ 块级 HTML，避免 <table> 嵌进 <p> 的非法嵌套
            content: '求 $x^2+1$ 的值\n\n<table><tr><th>甲</th><td>乙</td></tr></table>',
            type: 'calculation',
            difficulty: 2,
            knowledgePoints: [],
          },
        },
      ],
    });

    const { container } = renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');
    fireEvent.click(within(screen.getByTestId('error-row-91')).getByRole('button', { name: /展开/ }));

    const html = container.innerHTML;
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-error');
    // 原生 HTML 表格必须是真 <table>，不是被转义成字面文本
    expect(screen.getByTestId('error-detail-91').querySelector('table')).not.toBeNull();
    expect(screen.getByTestId('error-detail-91')).not.toHaveTextContent('<table>');
  });

  it('切轨道 Tab → track 传给后端并回到第 1 页', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    fireEvent.click(screen.getByRole('tab', { name: '全部' }));

    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({ studentId: 11, page: 1 }),
    );
  });

  it('翻页 → page 递增；「自报家门」不匹配时不渲染（防页码错配）', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    getErrorsMock.mockResolvedValue({ ...PAGE, page: 2, items: [PAGE.items[0]] });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => expect(getErrorsMock).toHaveBeenLastCalledWith({ studentId: 11, track: 'main', page: 2 }));
    expect(await screen.findByTestId('error-row-91')).toBeInTheDocument();
  });

  it('响应「自报家门」的页号与当前页不符 → 不渲染（防页码错配）', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    // 服务端原样回显请求页码；这里用不一致的回显页号来模拟翻页途中响应错配，
    // 验证守卫不会渲染旧页内容
    getErrorsMock.mockResolvedValue({ ...PAGE, page: 1 });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({ studentId: 11, track: 'main', page: 2 }),
    );
    expect(screen.queryByTestId('error-row-91')).not.toBeInTheDocument();
    expect(await screen.findByTestId('errors-skeleton')).toBeInTheDocument();
  });

  it('切轨道 Tab 时清掉来源筛选（track=training 叠加 source=exam 是永不匹配的组合）', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'exam' } });
    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({
        studentId: 11, track: 'main', source: 'exam', page: 1,
      }),
    );

    fireEvent.click(screen.getByRole('tab', { name: '训练' }));

    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({ studentId: 11, track: 'training', page: 1 }),
    );
  });

  it('轨道只有 全部/主线/训练 三个 Tab（辅线已并入训练，不再单列）', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['全部', '主线', '训练']);
    expect(tabs).not.toContain('辅线');
  });

  it('来源下拉按轨道分区：主线档选不到辅线答疑，训练档反过来', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    const sourceSelect = screen.getByLabelText('来源');
    const labels = within(sourceSelect)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toContain('真题考试');
    expect(labels).not.toContain('辅线答疑');
    expect(labels).not.toContain('专项练习');

    // 切到训练后反过来：辅线答疑与专项练习都在，考试不在
    fireEvent.click(screen.getByRole('tab', { name: '训练' }));
    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({ studentId: 11, track: 'training', page: 1 }),
    );
    const trainingLabels = within(screen.getByLabelText('来源'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(trainingLabels).toContain('辅线答疑');
    expect(trainingLabels).toContain('专项练习');
    expect(trainingLabels).not.toContain('真题考试');
  });

  it('训练档的行标「训练」+「辅线答疑」来源（问过的题归训练，不单列辅线轨）', async () => {
    getErrorsMock.mockResolvedValue({ ...PAGE, items: [PAGE.items[1]] });

    renderAt('/parent/errors');
    await screen.findByTestId('error-row-92');

    const row = screen.getByTestId('error-row-92');
    expect(within(row).getByText('训练')).toBeInTheDocument();
    expect(within(row).getByText('辅线答疑')).toBeInTheDocument();
  });

  it('已翻到第 2 页时切换孩子 → 请求回到第 1 页（否则停在误导性空态且无法自救）', async () => {
    const GIRL: MyStudentItem = { id: 12, parentId: 3, username: 'xiaohong', name: '小红', age: 12, grade: '初一', schoolLevel: 'junior', isActive: true };
    listMyStudentsMock.mockResolvedValue([BOY, GIRL]);
    // 回显页号跟随请求页，模拟正常翻页
    getErrorsMock.mockImplementation(async (params) =>
      params.page === 2 ? { ...PAGE, page: 2, items: [PAGE.items[0]] } : PAGE,
    );

    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({ studentId: 11, track: 'main', page: 2 }),
    );

    // 顶栏切到另一个孩子
    fireEvent.click(await screen.findByTestId('student-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('student-option-12'));

    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({ studentId: 12, track: 'main', page: 1 }),
    );
  });

  it('清零状态筛选透传；切筛选回第 1 页', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    fireEvent.change(screen.getByLabelText('清零状态'), { target: { value: 'uncleared' } });

    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({
        studentId: 11, track: 'main', cleared: 'uncleared', page: 1,
      }),
    );
  });

  it('学科筛选：下拉来自 /content/subjects，选中后 subject 透传', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    // 下拉选项是接口给的，不是硬编码
    const subjectSelect = await screen.findByLabelText('学科');
    expect(within(subjectSelect).getByRole('option', { name: '语文' })).toBeInTheDocument();

    fireEvent.change(subjectSelect, { target: { value: '2' } });

    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({
        studentId: 11, track: 'main', subject: 2, page: 1,
      }),
    );
  });

  it('空数据 → 空态，不出分页', async () => {
    getErrorsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    renderAt('/parent/errors');

    expect(await screen.findByTestId('errors-empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument();
  });

  it('没有选孩子 → 空态，不发请求', async () => {
    // 必须让切换器拿到**空列表**：否则它会把锚点回落成第一个孩子，页面就开始取数了
    useParentStudentStore.setState({ studentId: null });
    listMyStudentsMock.mockResolvedValue([]);

    renderAt('/parent/errors');

    expect(await screen.findByTestId('errors-no-student')).toBeInTheDocument();
    expect(getErrorsMock).not.toHaveBeenCalled();
  });
});
