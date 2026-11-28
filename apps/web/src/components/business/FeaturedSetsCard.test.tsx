import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import FeaturedSetsCard from './FeaturedSetsCard';
import {
  type FeaturedRunPayload,
  type FeaturedSetListItem,
  type FeaturedSetPage,
} from '@/services/api';
import { parseRunHandoff } from '@/pages/student/training/run-handoff';

/**
 * 个人中心「精选题单」卡片（Task 11）。
 *
 * 钉住五件事：
 * 1. 未读总数来自独立的 unread-count 端点，翻页不会重拉它；
 * 2. 空题单给固定空态文案；
 * 3. 未读行有「新」标记（线性 SVG 圆点 + 文字），已读行没有；
 * 4. 开题调用 openFeaturedSet，写 *featured* 交接体（sessionId=null、服务端 sessionUid）
 *    并带 subjectId/returnTo 跳到运行页 —— 交接体必须能被 TargetedRunPage 的
 *    parseRunHandoff 原样读回；
 * 5. 开题中禁用该行，失败留在本页可重试。
 *
 * vitest globals:false —— 显式 import + 自己写 afterEach(cleanup)。
 */

const listFeaturedSetsMock = vi.hoisted(() => vi.fn());
const getFeaturedUnreadSummaryMock = vi.hoisted(() => vi.fn());
const openFeaturedSetMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listFeaturedSets: listFeaturedSetsMock,
    getFeaturedUnreadSummary: getFeaturedUnreadSummaryMock,
    openFeaturedSet: openFeaturedSetMock,
  };
});

const UNREAD_ITEM: FeaturedSetListItem = {
  publicationId: 12,
  setId: 7,
  title: '七年级数学精选',
  subjectId: 1,
  subjectName: '数学',
  questionCount: 5,
  publishedAt: '2026-11-28T00:00:00Z',
  isRead: false,
};

const READ_ITEM: FeaturedSetListItem = {
  ...UNREAD_ITEM,
  publicationId: 13,
  title: '已读题单',
  isRead: true,
};

function featuredPage(over: Partial<FeaturedSetPage> = {}): FeaturedSetPage {
  return { items: [UNREAD_ITEM], page: 1, pageSize: 20, total: 1, ...over };
}

const PAYLOAD: FeaturedRunPayload = {
  mode: 'featured',
  sessionUid: 'u-1',
  subjectId: 1,
  title: '七年级数学精选',
  questions: [
    {
      questionId: 1,
      text: '题',
      type: 'choice',
      options: null,
      materialText: null,
      materialUrl: null,
    },
  ],
};

function renderCard() {
  const router = createMemoryRouter(
    [
      { path: '/student/profile', element: <FeaturedSetsCard /> },
      { path: '/student/training/targeted/run', element: <div>运行页桩</div> },
    ],
    { initialEntries: ['/student/profile'] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

beforeEach(() => {
  listFeaturedSetsMock.mockReset();
  getFeaturedUnreadSummaryMock.mockReset();
  openFeaturedSetMock.mockReset();
  listFeaturedSetsMock.mockResolvedValue(featuredPage());
  getFeaturedUnreadSummaryMock.mockResolvedValue({ count: 0, latest: null });
  openFeaturedSetMock.mockResolvedValue(PAYLOAD);
  sessionStorage.clear();
});

describe('FeaturedSetsCard', () => {
  it('渲染未读精选题，点击开题后写入 featured 交接体并跳运行页', async () => {
    listFeaturedSetsMock.mockResolvedValue(featuredPage());
    openFeaturedSetMock.mockResolvedValue(PAYLOAD);

    const { router } = renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /七年级数学精选/ }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/student/training/targeted/run'),
    );
    expect(JSON.parse(sessionStorage.getItem('training:targeted')!)).toMatchObject({
      mode: 'featured',
      sessionId: null,
      sessionUid: 'u-1',
    });
    expect(openFeaturedSetMock).toHaveBeenCalledWith(12);
    expect(router.state.location.search).toContain('subjectId=1');
    expect(router.state.location.search).toContain('returnTo=%2Fstudent%2Ffeatured-sets');
  });

  it('交接体能被 TargetedRunPage 的 parseRunHandoff 原样读回（题目/title 不丢）', async () => {
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /七年级数学精选/ }));

    await waitFor(() =>
      expect(parseRunHandoff(sessionStorage.getItem('training:targeted'))).not.toBeNull(),
    );
    const handoff = parseRunHandoff(sessionStorage.getItem('training:targeted'));
    expect(handoff).toMatchObject({
      mode: 'featured',
      sessionId: null,
      sessionUid: 'u-1',
      title: '七年级数学精选',
    });
    expect(handoff?.questions).toEqual(PAYLOAD.questions);
  });

  it('空题单显示「暂无精选题单」', async () => {
    listFeaturedSetsMock.mockResolvedValue(featuredPage({ items: [], total: 0 }));

    renderCard();

    expect(await screen.findByText('暂无精选题单')).toBeInTheDocument();
  });

  it('未读总数显示在标题旁，未读行有线性 SVG 圆点与「新」标记，已读行没有', async () => {
    listFeaturedSetsMock.mockResolvedValue(
      featuredPage({ items: [UNREAD_ITEM, READ_ITEM], total: 2 }),
    );
    getFeaturedUnreadSummaryMock.mockResolvedValue({
      count: 1,
      latest: { publicationId: 12, title: '七年级数学精选' },
    });

    renderCard();

    const card = await screen.findByTestId('featured-sets-card');
    expect(card).toHaveTextContent('精选题单');
    expect(card).toHaveTextContent('1 条未读');

    const unreadButton = within(card).getByRole('button', { name: /七年级数学精选/ });
    expect(within(unreadButton).getByText('新')).toBeInTheDocument();
    expect(unreadButton.querySelector('svg')).not.toBeNull();

    const readButton = within(card).getByRole('button', { name: /已读题单/ });
    expect(within(readButton).queryByText('新')).toBeNull();
    expect(readButton.querySelector('svg')).toBeNull();
  });

  it('翻页只重拉列表；未读总数不随页变化', async () => {
    listFeaturedSetsMock
      .mockResolvedValueOnce(featuredPage({ total: 25 }))
      .mockResolvedValueOnce(
        featuredPage({
          items: [{ ...UNREAD_ITEM, publicationId: 21, title: '第二页题单' }],
          page: 2,
          total: 25,
        }),
      );
    getFeaturedUnreadSummaryMock.mockResolvedValue({
      count: 3,
      latest: { publicationId: 12, title: '七年级数学精选' },
    });

    renderCard();

    expect(await screen.findByText('第 1 / 2 页')).toBeInTheDocument();
    expect(screen.getByTestId('featured-sets-card')).toHaveTextContent('3 条未读');
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    expect(await screen.findByText('第二页题单')).toBeInTheDocument();
    expect(listFeaturedSetsMock).toHaveBeenLastCalledWith(2);
    expect(getFeaturedUnreadSummaryMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('featured-sets-card')).toHaveTextContent('3 条未读');
    expect(screen.getByText('第 2 / 2 页')).toBeInTheDocument();
  });

  it('开题中禁用该行；开题失败留在本页且行恢复可点', async () => {
    let resolveOpen: ((value: FeaturedRunPayload) => void) | null = null;
    openFeaturedSetMock.mockReturnValue(
      new Promise<FeaturedRunPayload>((resolve) => {
        resolveOpen = resolve;
      }),
    );

    renderCard();
    const row = await screen.findByRole('button', { name: /七年级数学精选/ });
    fireEvent.click(row);

    expect(row).toBeDisabled();
    expect(listFeaturedSetsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOpen!(PAYLOAD);
    });
    await waitFor(() => expect(sessionStorage.getItem('training:targeted')).not.toBeNull());

    openFeaturedSetMock.mockReset();
    openFeaturedSetMock.mockRejectedValue(new Error('boom'));
    // 回到本页重新挂载一株，验证失败分支不写交接体、按钮恢复
    cleanup();
    sessionStorage.clear();
    renderCard();
    const retryRow = await screen.findByRole('button', { name: /七年级数学精选/ });
    fireEvent.click(retryRow);
    await waitFor(() => expect(retryRow).toBeEnabled());
    expect(sessionStorage.getItem('training:targeted')).toBeNull();
    expect(screen.getByTestId('featured-sets-card')).toHaveTextContent('开题失败');
  });
});
