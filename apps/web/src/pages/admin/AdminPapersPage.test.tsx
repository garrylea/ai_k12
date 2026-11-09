import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminPapersPage from './AdminPapersPage';
import {
  ApiError,
  deleteAdminPaper,
  getAdminPaperDeletePreview,
  listAdminPapers,
  type AdminPaperDeletePreview,
  type AdminPaperListResult,
} from '@/services/api';
import { toast } from '@/components/base';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listAdminPapers: vi.fn(),
    getAdminPaperDeletePreview: vi.fn(),
    deleteAdminPaper: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const listMock = vi.mocked(listAdminPapers);
const previewMock = vi.mocked(getAdminPaperDeletePreview);
const deleteMock = vi.mocked(deleteAdminPaper);
const toastMock = vi.mocked(toast);

function listResult(over: Partial<AdminPaperListResult> = {}): AdminPaperListResult {
  return {
    items: [
      {
        id: 446, subjectId: 9, subjectName: '道德与法治', title: '汇文卷',
        grade: '初三', gradeBand: 'junior', semester: 'first', year: 2026,
        district: '', examType: '期中', sourceKey: 'k',
        questionCount: 14, sessionCount: 1, createdAt: '2026-11-07T01:15:00.029Z',
      },
    ],
    total: 1, page: 1, pageSize: 20,
    ...over,
  };
}

const PREVIEW: AdminPaperDeletePreview = {
  paperId: 446, title: '汇文卷', subjectName: '道德与法治',
  questionCount: 14, sharedCount: 1, exclusiveCount: 13, deletableCount: 10,
  retainedCount: 3, sessionCount: 1, answerCount: 5,
};

beforeEach(() => {
  listMock.mockReset().mockResolvedValue(listResult());
  previewMock.mockReset().mockResolvedValue(PREVIEW);
  deleteMock.mockReset().mockResolvedValue({
    paperId: 446, deletedQuestions: 10, retainedQuestions: 3, deletedSessions: 1, deletedAnswers: 5,
  });
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AdminPapersPage 列表', () => {
  it('首屏渲染行数据与总数，默认 page=1 pageSize=20', async () => {
    render(<AdminPapersPage />);

    const table = await screen.findByTestId('papers-table');
    expect(table).toBeInTheDocument();
    expect(screen.getByText('汇文卷')).toBeInTheDocument();
    // 「道德与法治」在筛选下拉里也有一份，行数据要限定在表格内断言
    expect(within(table).getByText('道德与法治')).toBeInTheDocument();
    expect(screen.getByText('共 1 条')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
  });

  it('加载中 → Skeleton；失败 → 错误卡 + toast', async () => {
    listMock.mockReturnValueOnce(new Promise(() => {}));
    // 请求由 useEffect 在挂载时发起，rerender 不会重发 → 第二个场景换一次真实挂载
    const { unmount } = render(<AdminPapersPage />);
    expect(screen.getByTestId('papers-loading')).toBeInTheDocument();
    unmount();

    listMock.mockReset().mockRejectedValueOnce(new ApiError(5000, '服务异常'));
    render(<AdminPapersPage />);
    expect(await screen.findByTestId('papers-error')).toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith('error', '服务异常');
  });

  it('筛选提交后带条件重新请求并回第 1 页', async () => {
    render(<AdminPapersPage />);
    await screen.findByTestId('papers-table');

    fireEvent.change(screen.getByTestId('papers-filter-subject'), { target: { value: '9' } });
    fireEvent.change(screen.getByTestId('papers-filter-keyword'), { target: { value: '汇文' } });
    fireEvent.submit(screen.getByTestId('papers-filter-form'));

    await waitFor(() => {
      expect(listMock).toHaveBeenLastCalledWith({ subjectId: 9, keyword: '汇文', page: 1, pageSize: 20 });
    });
  });
});

describe('AdminPapersPage 删除', () => {
  it('点删除 → 先拉预览，确认框展示影响面数字', async () => {
    render(<AdminPapersPage />);
    await screen.findByTestId('papers-table');

    fireEvent.click(screen.getByTestId('paper-delete-446'));

    await waitFor(() => expect(previewMock).toHaveBeenCalledWith(446));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('共享题 1 道仅解除关联');
    expect(dialog).toHaveTextContent('被学生数据引用 3 道保留');
    expect(dialog).toHaveTextContent('考试会话 1 场、作答 5 条');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('确认 → 调 delete、toast 结果、重新拉列表', async () => {
    render(<AdminPapersPage />);
    await screen.findByTestId('papers-table');
    fireEvent.click(screen.getByTestId('paper-delete-446'));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByTitle('确认'));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(446));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('success', '已删除《汇文卷》：题目 10 道、会话 1 场'));
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('预览失败 → toast 且不开确认框', async () => {
    previewMock.mockRejectedValueOnce(new ApiError(5000, '服务异常'));
    render(<AdminPapersPage />);
    await screen.findByTestId('papers-table');

    fireEvent.click(screen.getByTestId('paper-delete-446'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '服务异常'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
