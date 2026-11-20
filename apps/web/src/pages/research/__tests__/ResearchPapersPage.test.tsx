import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ResearchPapersPage from '../ResearchPapersPage';
import {
  ApiError,
  deleteResearchPaper,
  getResearchPaperDeletePreview,
  listResearchPapers,
  type ResearchPaperDeletePreview,
  type ResearchPaperItem,
} from '@/services/api';
import { toast } from '@/components/base';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listResearchPapers: vi.fn(),
    getResearchPaperDeletePreview: vi.fn(),
    deleteResearchPaper: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const listMock = vi.mocked(listResearchPapers);
const previewMock = vi.mocked(getResearchPaperDeletePreview);
const deleteMock = vi.mocked(deleteResearchPaper);
const toastMock = vi.mocked(toast);

function paper(over: Partial<ResearchPaperItem> = {}): ResearchPaperItem {
  return {
    id: 1,
    subjectId: 1,
    subjectName: '数学',
    title: '汇文中学月考',
    grade: '初一',
    gradeBand: 'junior',
    semester: '上',
    year: 2026,
    district: '海淀',
    examType: '月考',
    sourceKey: '/hw-1',
    questionCount: 12,
    sessionCount: 5,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

function preview(over: Partial<ResearchPaperDeletePreview> = {}): ResearchPaperDeletePreview {
  return {
    paperId: 1,
    title: '汇文中学月考',
    subjectName: '数学',
    questionCount: 3,
    sharedCount: 1,
    exclusiveCount: 2,
    deletableCount: 2,
    retainedCount: 1,
    sessionCount: 1,
    answerCount: 2,
    ...over,
  };
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue({ items: [paper()], total: 1, page: 1, pageSize: 20 });
  previewMock.mockReset().mockResolvedValue(preview());
  deleteMock.mockReset().mockResolvedValue({
    paperId: 1,
    deletedQuestions: 3,
    retainedQuestions: 0,
    deletedSessions: 1,
    deletedAnswers: 2,
    deletedImages: 0,
  });
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ResearchPapersPage 筛选与四态', () => {
  it('默认全部学科、首屏 page=1/pageSize=20，且不附加学科筛选', async () => {
    listMock.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 });

    render(<ResearchPapersPage />);

    expect(await screen.findByTestId('papers-empty')).toBeInTheDocument();
    expect(screen.getByText('全部学科')).toBeInTheDocument();
    for (const name of ['数学', '语文', '英语', '物理', '化学', '道德与法治']) {
      expect(screen.getByRole('option', { name })).toBeInTheDocument();
    }
    expect(listMock).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
  });

  it('加载中 → Skeleton，不出错误卡/空态', () => {
    listMock.mockReturnValueOnce(new Promise(() => {}));

    render(<ResearchPapersPage />);

    expect(screen.getByTestId('papers-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('papers-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('papers-empty')).not.toBeInTheDocument();
  });

  it('失败 → 错误卡 + toast("error")', async () => {
    listMock.mockRejectedValueOnce(new ApiError(5000, '服务异常'));

    render(<ResearchPapersPage />);

    expect(await screen.findByTestId('papers-error')).toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith('error', '服务异常');
    expect(screen.queryByTestId('papers-table')).not.toBeInTheDocument();
  });

  it('就绪 → 用真实行数据渲染表格，标题可进入详情页', async () => {
    listMock.mockResolvedValueOnce({
      items: [paper({ id: 7, title: '真题卷 A', subjectName: '语文', year: 2025, grade: '初三', questionCount: 20, sessionCount: 9 })],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    render(<ResearchPapersPage />);

    const table = await screen.findByTestId('papers-table');
    expect(within(table).getByText('真题卷 A')).toBeInTheDocument();
    expect(within(table).getByText('语文')).toBeInTheDocument();
    expect(within(table).getByText('2025')).toBeInTheDocument();
    expect(within(table).getByText('初三')).toBeInTheDocument();
    expect(within(table).getByText('20')).toBeInTheDocument();
    expect(within(table).getByText('9')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '真题卷 A' })).toHaveAttribute('href', '/research/papers/7');
  });

  it('提交筛选 → 回到第 1 页并把学科/年份/关键词传给 API', async () => {
    render(<ResearchPapersPage />);
    await screen.findByTestId('papers-table');

    fireEvent.change(screen.getByTestId('papers-filter-subject'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('papers-filter-year'), { target: { value: '2025' } });
    fireEvent.change(screen.getByTestId('papers-filter-keyword'), { target: { value: '汇文' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => {
      expect(listMock).toHaveBeenLastCalledWith({ subjectId: 2, year: 2025, keyword: '汇文', page: 1, pageSize: 20 });
    });
  });
});

describe('ResearchPapersPage 删卷确认流程', () => {
  it('点删除 → 先拉预览并显示真实影响面数字，确认前不发删除', async () => {
    previewMock.mockResolvedValueOnce(preview({ questionCount: 3, sessionCount: 1, answerCount: 2 }));

    render(<ResearchPapersPage />);
    await screen.findByTestId('papers-table');
    fireEvent.click(screen.getByTestId('paper-delete-1'));

    const dialog = await screen.findByRole('dialog');
    expect(previewMock).toHaveBeenCalledWith(1);
    expect(dialog).toHaveTextContent('题目 3 道');
    expect(dialog).toHaveTextContent('考试会话 1 场');
    expect(dialog).toHaveTextContent('作答 2 条');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('确认 → 调 DELETE + toast("success") + 关框 + 重新拉列表', async () => {
    render(<ResearchPapersPage />);
    await screen.findByTestId('papers-table');
    const loadsBefore = listMock.mock.calls.length;

    fireEvent.click(screen.getByTestId('paper-delete-1'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    expect(deleteMock).toHaveBeenCalledWith(1);
    expect(toastMock).toHaveBeenCalledWith('success', expect.stringContaining('已删除'));
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(loadsBefore));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('取消 → 关框且不发删除请求', async () => {
    render(<ResearchPapersPage />);
    await screen.findByTestId('papers-table');

    fireEvent.click(screen.getByTestId('paper-delete-1'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('删除失败 → toast("error")，确认框不关，可重试', async () => {
    deleteMock.mockRejectedValueOnce(new ApiError(5000, '数据库异常'));

    render(<ResearchPapersPage />);
    await screen.findByTestId('papers-table');

    fireEvent.click(screen.getByTestId('paper-delete-1'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '数据库异常'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  /**
   * ConfirmDialog 的确认按钮没有 disabled，删除又是不可恢复操作 —— 用组件内
   * deletingRef 同步兜住连点。请求故意不 resolve，让三次点击都落在在途窗口内。
   */
  it('连点确认 → 只发一个 DELETE（deletingRef 防连点）', async () => {
    deleteMock.mockReturnValueOnce(new Promise(() => {}));

    render(<ResearchPapersPage />);
    await screen.findByTestId('papers-table');

    fireEvent.click(screen.getByTestId('paper-delete-1'));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: '确认' });

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });
});
