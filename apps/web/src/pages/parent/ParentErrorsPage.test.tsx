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
      id: 91, questionId: 330, track: 'main', source: 'exam', level: 2, isCleared: false,
      wrongAnswerText: 'x=3', createdAt: '2026-09-16T19:21:00.000Z', clearedAt: null,
      question: {
        content: '解方程 2x+1=7', type: 'calculation', difficulty: 3,
        knowledgePoints: [{ id: 42, name: '分数加减' }],
      },
    },
    {
      id: 92, questionId: null, track: 'aux', source: 'auxiliary', level: 1, isCleared: true,
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

  it('展开行显示题干/题型/知识点；question 为 null 的行只显示 wrongAnswerText', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    fireEvent.click(within(screen.getByTestId('error-row-91')).getByRole('button', { name: /展开/ }));
    expect(screen.getByTestId('error-detail-91')).toHaveTextContent('解方程 2x+1=7');
    expect(screen.getByTestId('error-detail-91')).toHaveTextContent('分数加减');

    fireEvent.click(screen.getByRole('tab', { name: '辅线' }));
    await screen.findByTestId('error-row-92');
    fireEvent.click(within(screen.getByTestId('error-row-92')).getByRole('button', { name: /展开/ }));
    expect(screen.getByTestId('error-detail-92')).toHaveTextContent('只存了题面');
    expect(screen.getByTestId('error-detail-92')).toHaveTextContent('题目未入库');
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

  it('切轨道 Tab 时清掉来源筛选（track=aux 叠加 source=exam 是永不匹配的组合）', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'exam' } });
    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({
        studentId: 11, track: 'main', source: 'exam', page: 1,
      }),
    );

    fireEvent.click(screen.getByRole('tab', { name: '辅线' }));

    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({ studentId: 11, track: 'aux', page: 1 }),
    );
  });

  it('主线 Tab 的来源下拉里**没有**「辅线答疑」（该组合永不匹配，必须选不出来）', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    const sourceSelect = screen.getByLabelText('来源');
    const labels = within(sourceSelect)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toContain('真题考试');
    expect(labels).not.toContain('辅线答疑');

    // 切到辅线后反过来：只剩辅线答疑（+ 全部来源）
    fireEvent.click(screen.getByRole('tab', { name: '辅线' }));
    await waitFor(() => expect(getErrorsMock).toHaveBeenLastCalledWith({ studentId: 11, track: 'aux', page: 1 }));
    const auxLabels = within(screen.getByLabelText('来源'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(auxLabels).toContain('辅线答疑');
    expect(auxLabels).not.toContain('真题考试');
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
