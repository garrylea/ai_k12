import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ResearchFeaturedSetsPage from '../ResearchFeaturedSetsPage';
import {
  getResearchFeaturedSet,
  listResearchFeaturedSets,
  publishFeaturedSet,
  rejectFeaturedSet,
  reopenFeaturedSet,
  withdrawFeaturedPublication,
  type ResearchFeaturedSetDetail,
  type ResearchFeaturedSetItem,
} from '@/services/api';
import { toast } from '@/components/base';

/**
 * 教研「精选题单」工作台回归。
 *
 * 钉住：三个固定 Tab、列表口径（题数/推荐人数/年级分布）、详情抽屉走共享 Markdown
 * 管线、发布弹窗的标题校验与年级下拉、拒绝/重新审核/撤回的可见性与请求、防连点、
 * 失败 toast。路由映射与侧栏角标由 routeTable.test.tsx 另测。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listResearchFeaturedSets: vi.fn(),
    getResearchFeaturedSet: vi.fn(),
    publishFeaturedSet: vi.fn(),
    rejectFeaturedSet: vi.fn(),
    reopenFeaturedSet: vi.fn(),
    withdrawFeaturedPublication: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const listMock = vi.mocked(listResearchFeaturedSets);
const detailMock = vi.mocked(getResearchFeaturedSet);
const publishMock = vi.mocked(publishFeaturedSet);
const rejectMock = vi.mocked(rejectFeaturedSet);
const reopenMock = vi.mocked(reopenFeaturedSet);
const withdrawMock = vi.mocked(withdrawFeaturedPublication);
const toastMock = vi.mocked(toast);

function item(over: Partial<ResearchFeaturedSetItem> = {}): ResearchFeaturedSetItem {
  return {
    setId: 7,
    subjectId: 1,
    subjectName: '数学',
    questionCount: 5,
    recommendationCount: 3,
    gradeDistribution: [
      { gradeCode: 'grade_7', count: 2 },
      { gradeCode: 'grade_8', count: 1 },
    ],
    reviewStatus: 'pending',
    createdAt: '2026-11-28T10:00:00Z',
    ...over,
  };
}

function detail(over: Partial<ResearchFeaturedSetDetail> = {}): ResearchFeaturedSetDetail {
  return {
    ...item(),
    questions: [
      {
        questionId: 101,
        text: '已知 **x=1**，求 x+1',
        type: 'single_choice',
        answer: '2',
        explanation: '解析文本',
      },
    ],
    publications: [],
    ...over,
  };
}

function page(over: Partial<{ items: ResearchFeaturedSetItem[]; total: number }> = {}) {
  return {
    items: over.items ?? [item()],
    page: 1,
    pageSize: 20,
    total: over.total ?? (over.items ? over.items.length : 1),
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ResearchFeaturedSetsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue(page());
  detailMock.mockReset().mockResolvedValue(detail());
  publishMock.mockReset().mockResolvedValue({ publicationId: 55 });
  rejectMock.mockReset().mockResolvedValue(null);
  reopenMock.mockReset().mockResolvedValue(null);
  withdrawMock.mockReset().mockResolvedValue(null);
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ResearchFeaturedSetsPage 列表与 Tab', () => {
  it('待审核列表显示题数、推荐人数和年级分布', async () => {
    listMock.mockResolvedValue({
      items: [
        {
          setId: 7,
          subjectId: 1,
          subjectName: '数学',
          questionCount: 5,
          recommendationCount: 3,
          gradeDistribution: [
            { gradeCode: 'grade_7', count: 2 },
            { gradeCode: 'grade_8', count: 1 },
          ],
          reviewStatus: 'pending',
          createdAt: '2026-11-28T10:00:00Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    renderPage();

    expect(await screen.findByText('数学')).toBeInTheDocument();
    expect(screen.getByText('5 题')).toBeInTheDocument();
    expect(screen.getByText('3 人推荐')).toBeInTheDocument();
    expect(screen.getByText('初一 2 · 初二 1')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith('pending', 1);
  });

  it('三个固定 Tab：待审核 / 已发布 / 已拒绝，切换后按对应 status 拉列表', async () => {
    renderPage();

    expect(await screen.findByRole('tab', { name: '待审核' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: '已发布' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '已拒绝' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '已发布' }));
    await waitFor(() => expect(listMock).toHaveBeenCalledWith('approved', 1));
    expect(screen.getByRole('tab', { name: '已发布' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: '已拒绝' }));
    await waitFor(() => expect(listMock).toHaveBeenCalledWith('rejected', 1));
    expect(screen.getByRole('tab', { name: '已拒绝' })).toHaveAttribute('aria-selected', 'true');
  });

  it('未匹配年级 code 用原 code 兜底，不显示 undefined', async () => {
    listMock.mockResolvedValue(
      page({ items: [item({ gradeDistribution: [{ gradeCode: 'unknown_g', count: 4 }] })] }),
    );

    renderPage();

    expect(await screen.findByText('unknown_g 4')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });
});

describe('ResearchFeaturedSetsPage 详情抽屉', () => {
  it('点击行调用 getResearchFeaturedSet，抽屉展示题目与 publication，题目正文走共享 Markdown', async () => {
    detailMock.mockResolvedValue(
      detail({
        publications: [
          {
            publicationId: 55,
            gradeCode: 'grade_7',
            title: '七年级精选题',
            reachCount: 12,
            status: 'published',
            publishedAt: '2026-11-28T11:00:00Z',
          },
        ],
      }),
    );

    renderPage();
    fireEvent.click(await screen.findByTestId('featured-set-row-7'));

    const dialog = await screen.findByRole('dialog');
    expect(detailMock).toHaveBeenCalledWith(7);
    expect(await within(dialog).findByText('七年级精选题')).toBeInTheDocument();
    expect(within(dialog).getByText('解析文本')).toBeInTheDocument();
    // 共享 ReactMarkdown 管线：`**x=1**` 必须渲染成 <strong>，而不是字面量
    const strong = within(dialog).getByText('x=1');
    expect(strong.tagName).toBe('STRONG');
  });

  it('详情加载失败 → toast(error)，抽屉不崩', async () => {
    detailMock.mockRejectedValueOnce(new Error('详情接口挂了'));

    renderPage();
    fireEvent.click(await screen.findByTestId('featured-set-row-7'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '详情接口挂了'));
  });
});

describe('ResearchFeaturedSetsPage 发布弹窗', () => {
  async function openPublish() {
    renderPage();
    fireEvent.click(await screen.findByTestId('featured-publish-7'));
    return await screen.findByRole('dialog');
  }

  it('年级下拉来自完整年级列表（含 grade_7 初一）', async () => {
    const dialog = await openPublish();

    const select = within(dialog).getByTestId('publish-grade-select');
    expect(within(select).getByRole('option', { name: '初一' })).toHaveValue('grade_7');
    expect(within(select).getByRole('option', { name: '高三' })).toHaveValue('grade_12');
  });

  it('标题空白（trim 后为空）或超过 60 字不发请求', async () => {
    const dialog = await openPublish();
    const title = within(dialog).getByTestId('publish-title-input');
    const submit = within(dialog).getByTestId('publish-submit');

    fireEvent.change(title, { target: { value: '   ' } });
    fireEvent.click(submit);
    expect(publishMock).not.toHaveBeenCalled();

    fireEvent.change(title, { target: { value: '合'.repeat(61) } });
    fireEvent.click(submit);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('合法提交：trim 标题、关闭弹窗、保持当前 Tab、刷新列表', async () => {
    const dialog = await openPublish();
    const callsBefore = listMock.mock.calls.length;

    fireEvent.change(within(dialog).getByTestId('publish-title-input'), {
      target: { value: '  七年级精选题  ' },
    });
    fireEvent.change(within(dialog).getByTestId('publish-grade-select'), {
      target: { value: 'grade_7' },
    });
    fireEvent.click(within(dialog).getByTestId('publish-submit'));

    await waitFor(() =>
      expect(publishMock).toHaveBeenCalledWith(7, {
        title: '七年级精选题',
        gradeCode: 'grade_7',
      }),
    );
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(callsBefore));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('tab', { name: '待审核' })).toHaveAttribute('aria-selected', 'true');
  });

  it('发布失败 → toast(error)，弹窗保持打开', async () => {
    publishMock.mockRejectedValueOnce(new Error('发布失败'));
    const dialog = await openPublish();

    fireEvent.change(within(dialog).getByTestId('publish-title-input'), {
      target: { value: '标题' },
    });
    fireEvent.click(within(dialog).getByTestId('publish-submit'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '发布失败'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('防连点：连点两次提交只发一次请求', async () => {
    let resolvePublish!: (value: { publicationId: number }) => void;
    publishMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePublish = resolve;
      }),
    );
    const dialog = await openPublish();

    fireEvent.change(within(dialog).getByTestId('publish-title-input'), {
      target: { value: '标题' },
    });
    const submit = within(dialog).getByTestId('publish-submit');
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(publishMock).toHaveBeenCalledTimes(1);
    resolvePublish({ publicationId: 55 });
  });
});

describe('ResearchFeaturedSetsPage 拒绝 / 重新审核 / 撤回', () => {
  it('拒绝：ConfirmDialog 确认后调 rejectFeaturedSet，取消不发请求', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('featured-reject-7'));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(rejectMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('featured-reject-7'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认' }));

    await waitFor(() => expect(rejectMock).toHaveBeenCalledWith(7));
  });

  it('重新审核只在已拒绝行显示，点击调 reopenFeaturedSet', async () => {
    listMock.mockResolvedValue(page({ items: [item({ setId: 9, reviewStatus: 'rejected' })] }));

    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: '已拒绝' }));
    const row = await screen.findByTestId('featured-set-row-9');
    const reopen = within(row).getByTestId('featured-reopen-9');
    fireEvent.click(reopen);

    await waitFor(() => expect(reopenMock).toHaveBeenCalledWith(9));

    listMock.mockResolvedValue(page());
    fireEvent.click(screen.getByRole('tab', { name: '待审核' }));
    await screen.findByTestId('featured-set-row-7');
    expect(screen.queryByTestId('featured-reopen-7')).not.toBeInTheDocument();
  });

  it('撤回只在 published publication 显示，点击调 withdrawFeaturedPublication', async () => {
    detailMock.mockResolvedValue(
      detail({
        publications: [
          {
            publicationId: 55,
            gradeCode: 'grade_7',
            title: '七年级精选题',
            reachCount: 12,
            status: 'published',
            publishedAt: '2026-11-28T11:00:00Z',
          },
          {
            publicationId: 56,
            gradeCode: 'grade_8',
            title: '八年级精选题',
            reachCount: 10,
            status: 'withdrawn',
            publishedAt: '2026-11-27T11:00:00Z',
          },
        ],
      }),
    );

    renderPage();
    fireEvent.click(await screen.findByTestId('featured-set-row-7'));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByTestId('featured-withdraw-55')).toBeInTheDocument();
    expect(within(dialog).queryByTestId('featured-withdraw-56')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByTestId('featured-withdraw-55'));
    await waitFor(() => expect(withdrawMock).toHaveBeenCalledWith(55));
  });

  it('操作失败统一 toast(error)', async () => {
    reopenMock.mockRejectedValueOnce(new Error('重新审核失败'));
    listMock.mockResolvedValue(page({ items: [item({ setId: 9, reviewStatus: 'rejected' })] }));

    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: '已拒绝' }));
    fireEvent.click(await screen.findByTestId('featured-reopen-9'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '重新审核失败'));
  });
});
