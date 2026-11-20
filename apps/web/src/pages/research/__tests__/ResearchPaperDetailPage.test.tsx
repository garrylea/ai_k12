import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ResearchPaperDetailPage from '../ResearchPaperDetailPage';
import {
  ApiError,
  getResearchPaper,
  type ResearchPaperDetailResult,
  type ResearchQuestionDetail,
} from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getResearchPaper: vi.fn() };
});

/**
 * Task 10 抽屉的契约测试替身：详情页只需把点击的那道题（含五字段原值）传给
 * <ResearchQuestionEditDrawer question onClose onSaved />，不关心抽屉内部实现。
 */
vi.mock('@/pages/research/ResearchQuestionEditDrawer', () => ({
  default: ({
    question,
    onClose,
    onSaved,
  }: {
    question: ResearchQuestionDetail;
    onClose: () => void;
    onSaved: () => void;
  }) => (
    <div role="dialog" data-testid="drawer-stub">
      <span data-testid="drawer-content">{question.content}</span>
      <span data-testid="drawer-options">{JSON.stringify(question.options)}</span>
      <span data-testid="drawer-answer">{question.answer}</span>
      <span data-testid="drawer-explanation">{question.explanation ?? ''}</span>
      <span data-testid="drawer-approach">{question.approach ?? ''}</span>
      <button onClick={onClose}>关闭抽屉</button>
      <button onClick={onSaved}>保存完成</button>
    </div>
  ),
}));

const detailMock = vi.mocked(getResearchPaper);

function question(over: Partial<ResearchQuestionDetail> = {}): ResearchQuestionDetail {
  return {
    id: 9,
    questionNo: 1,
    type: 'choice',
    content: `题干正文${'很长的内容'.repeat(30)}`,
    options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }],
    answer: 'B',
    explanation: '乙正确',
    approach: '排除法',
    source: '汇文中学',
    sourceYear: 2026,
    answerVerified: true,
    isActive: true,
    ...over,
  };
}

function detail(over: Partial<ResearchPaperDetailResult> = {}): ResearchPaperDetailResult {
  return {
    paper: {
      id: 7,
      subjectId: 1,
      subjectName: '数学',
      title: '真题卷 A',
      grade: '初一',
      gradeBand: 'junior',
      semester: '上',
      year: 2026,
      district: '海淀',
      examType: '月考',
      sourceKey: '/a',
      questionCount: 1,
      sessionCount: 0,
      createdAt: '2026-11-01T00:00:00.000Z',
    },
    questions: [question()],
    ...over,
  };
}

function renderDetail(path = '/research/papers/7') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/research/papers/:id" element={<ResearchPaperDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  detailMock.mockReset().mockResolvedValue(detail());
});

afterEach(() => {
  cleanup();
});

describe('ResearchPaperDetailPage 加载与表格', () => {
  it('按路由 id 调 getResearchPaper(Number(id))，渲染七列表格', async () => {
    renderDetail('/research/papers/7');

    expect(detailMock).toHaveBeenCalledWith(7);
    const table = await screen.findByTestId('detail-table');
    for (const header of ['题号', '题型', '题干', '答案', '解析', '来源', '操作']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    const row = within(table).getByRole('row', { name: /1.*choice.*B/ });
    expect(within(row).getByText('choice')).toBeInTheDocument();
    expect(within(row).getByText('B')).toBeInTheDocument();
    expect(within(row).getByText('有')).toBeInTheDocument();
    expect(within(row).getByText('汇文中学 2026')).toBeInTheDocument();
    // 题干截断：表格里只有摘要，完整原文不直接铺在表格中
    expect(within(row).getByText(/题干正文/)).toBeInTheDocument();
    expect(screen.queryByText(question().content)).not.toBeInTheDocument();
  });

  it('解析为空 → 解析列显示「无」', async () => {
    detailMock.mockResolvedValueOnce(detail({ questions: [question({ id: 10, explanation: null })] }));

    renderDetail();

    const table = await screen.findByTestId('detail-table');
    expect(within(table).getByText('无')).toBeInTheDocument();
  });

  it('加载中 → Skeleton，不出表格/错误/空态', () => {
    detailMock.mockReturnValueOnce(new Promise(() => {}));

    renderDetail();

    expect(screen.getByTestId('detail-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('detail-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('detail-error')).not.toBeInTheDocument();
  });

  it('失败 → 错误分支', async () => {
    detailMock.mockRejectedValueOnce(new ApiError(5000, '服务异常'));

    renderDetail();

    expect(await screen.findByTestId('detail-error')).toBeInTheDocument();
    expect(screen.getByText('试卷详情加载失败，请稍后重试')).toBeInTheDocument();
  });

  it('无题目 → 空态分支', async () => {
    detailMock.mockResolvedValueOnce(detail({ questions: [] }));

    renderDetail();

    expect(await screen.findByTestId('detail-empty')).toBeInTheDocument();
    expect(screen.getByText('该试卷暂无题目')).toBeInTheDocument();
  });

  it('路由 id 非法 → 不发请求并落到错误分支', () => {
    renderDetail('/research/papers/abc');

    expect(screen.getByTestId('detail-error')).toBeInTheDocument();
    expect(detailMock).not.toHaveBeenCalled();
  });
});

describe('ResearchPaperDetailPage 编辑入口契约', () => {
  it('点「编辑」→ 把该题完整五字段交给 Task 10 抽屉', async () => {
    const q = question({ id: 9, questionNo: 2, content: '第二题题干' });
    detailMock.mockResolvedValueOnce(detail({ questions: [q] }));

    renderDetail();
    const table = await screen.findByTestId('detail-table');
    fireEvent.click(within(table).getByRole('button', { name: '编辑' }));

    const drawer = await screen.findByTestId('drawer-stub');
    expect(screen.getByTestId('drawer-content')).toHaveTextContent('第二题题干');
    expect(screen.getByTestId('drawer-options')).toHaveTextContent('"label":"A"');
    expect(screen.getByTestId('drawer-answer')).toHaveTextContent('B');
    expect(screen.getByTestId('drawer-explanation')).toHaveTextContent('乙正确');
    expect(screen.getByTestId('drawer-approach')).toHaveTextContent('排除法');
    expect(within(drawer).getByRole('button', { name: '关闭抽屉' })).toBeInTheDocument();
  });

  it('关闭抽屉 → 抽屉消失', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));

    fireEvent.click(screen.getByRole('button', { name: '关闭抽屉' }));

    await waitFor(() => expect(screen.queryByTestId('drawer-stub')).not.toBeInTheDocument());
  });

  it('保存完成 → 关闭抽屉并重新拉取详情', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    expect(detailMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '保存完成' }));

    await waitFor(() => expect(detailMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('drawer-stub')).not.toBeInTheDocument();
  });
});
