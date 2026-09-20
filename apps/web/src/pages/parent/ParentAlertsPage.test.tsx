import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ParentAlertsPage from './ParentAlertsPage';
import {
  ApiError,
  getParentAlerts,
  listMyStudents,
  markParentAlertRead,
  type MyStudentItem,
  type ParentAlertItem,
  type ParentAlertPage,
} from '@/services/api';
import { toast } from '@/components/base';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getParentAlerts: vi.fn(),
    listMyStudents: vi.fn(),
    markParentAlertRead: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const getAlertsMock = vi.mocked(getParentAlerts);
const listStudentsMock = vi.mocked(listMyStudents);
const markReadMock = vi.mocked(markParentAlertRead);
const toastMock = vi.mocked(toast);

const BOY: MyStudentItem = {
  id: 11,
  parentId: 3,
  username: 'xiaoming',
  name: '小明',
  age: 13,
  grade: '初一',
  schoolLevel: 'junior',
  isActive: true,
};
const GIRL: MyStudentItem = { ...BOY, id: 12, username: 'xiaohong', name: '小红' };

function alertItem(over: Partial<ParentAlertItem> = {}): ParentAlertItem {
  return {
    id: 1,
    studentId: 11,
    studentName: '小明',
    type: 'off_topic',
    level: 'warning',
    message: '检测到孩子在学习中发起了与学习无关的闲聊',
    context: '你喜欢什么游戏？',
    dialogueId: 88,
    isRead: false,
    createdAt: '2026-09-20T10:00:00.000Z',
    ...over,
  };
}

function pageOf(items: ParentAlertItem[], over: Partial<ParentAlertPage> = {}): ParentAlertPage {
  return { items, total: items.length, page: 1, pageSize: 20, ...over };
}

/** 回显请求页号：服务端契约如此，派生状态的归属守卫也依赖它。 */
function echoPage(params?: { page?: number; total?: number; items?: ParentAlertItem[] }) {
  return Promise.resolve(
    pageOf(params?.items ?? [alertItem()], {
      total: params?.total ?? (params?.items ?? [alertItem()]).length,
      page: params?.page ?? 1,
    }),
  );
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ParentAlertsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getAlertsMock.mockReset().mockResolvedValue(pageOf([]));
  listStudentsMock.mockReset().mockResolvedValue([BOY, GIRL]);
  markReadMock.mockReset().mockResolvedValue(null);
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ParentAlertsPage 四态（spec §5.2）', () => {
  it('加载中 → Skeleton（不出空态）', () => {
    getAlertsMock.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByTestId('alerts-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('alerts-empty')).not.toBeInTheDocument();
  });

  it('请求失败 → 错误卡；点重试可重新拉取', async () => {
    getAlertsMock.mockRejectedValueOnce(new ApiError(5000, '服务异常'));

    renderPage();
    expect(await screen.findByTestId('alerts-error')).toBeInTheDocument();

    const before = getAlertsMock.mock.calls.length;
    getAlertsMock.mockResolvedValueOnce(pageOf([alertItem()]));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByTestId('alert-row-1')).toBeInTheDocument();
    expect(getAlertsMock.mock.calls.length).toBeGreaterThan(before);
  });

  it('空（无筛选）→ 「暂无预警」，且没有「清除筛选」', async () => {
    renderPage();

    expect(await screen.findByTestId('alerts-empty')).toBeInTheDocument();
    expect(screen.getByText('暂无预警')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '清除筛选' })).not.toBeInTheDocument();
  });

  it('空（筛选后）→ 「当前筛选下没有预警」+ 清除筛选可复原', async () => {
    renderPage();
    await screen.findByTestId('alerts-empty');

    fireEvent.click(screen.getByRole('button', { name: '只看未读' }));

    expect(await screen.findByText('当前筛选下没有预警')).toBeInTheDocument();
    expect(getAlertsMock).toHaveBeenLastCalledWith({ unreadOnly: true, page: 1 });

    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));

    await waitFor(() => expect(getAlertsMock).toHaveBeenLastCalledWith({ page: 1 }));
    expect(await screen.findByText('暂无预警')).toBeInTheDocument();
  });

  it('有数据 → 行含级别/类型/孩子名/上下文/建议行动/查看对话', async () => {
    getAlertsMock.mockResolvedValue(pageOf([alertItem()]));

    renderPage();

    const row = await screen.findByTestId('alert-row-1');
    expect(within(row).getByText('警告')).toBeInTheDocument();
    expect(within(row).getByText('偏离学习')).toBeInTheDocument();
    expect(within(row).getByText('小明')).toBeInTheDocument();
    expect(within(row).getByText('上下文：你喜欢什么游戏？')).toBeInTheDocument();
    expect(within(row).getByText(/^建议行动：/)).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: '查看对话' })).toHaveAttribute(
      'href',
      '/parent/chat-logs',
    );
  });

  it('dialogueId 为 null → 不渲染「查看对话」', async () => {
    getAlertsMock.mockResolvedValue(pageOf([alertItem({ type: 'idle', dialogueId: null })]));

    renderPage();

    const row = await screen.findByTestId('alert-row-1');
    expect(within(row).queryByRole('link', { name: '查看对话' })).not.toBeInTheDocument();
    // 类型文案按 6 值静态映射（idle → 长时间无操作）
    expect(within(row).getByText('长时间无操作')).toBeInTheDocument();
  });

  it('默认展示全部孩子：不传 studentId，且下拉默认「全部孩子」', async () => {
    renderPage();

    await waitFor(() => expect(getAlertsMock).toHaveBeenCalledWith({ page: 1 }));
    expect(screen.getByLabelText('孩子')).toHaveValue('');
    expect(screen.getByRole('option', { name: '全部孩子' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '小红' })).toBeInTheDocument();
  });
});

describe('ParentAlertsPage 交互（spec §5.2）', () => {
  it('标记已读（全部）→ 就地更新为已读：行仍在、按钮消失、不整页重拉', async () => {
    getAlertsMock.mockResolvedValue(pageOf([alertItem()]));

    renderPage();
    const row = await screen.findByTestId('alert-row-1');
    fireEvent.click(within(row).getByRole('button', { name: '标记已读' }));

    await waitFor(() => expect(markReadMock).toHaveBeenCalledWith(1));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('alert-row-1')).queryByRole('button', { name: '标记已读' }),
      ).not.toBeInTheDocument(),
    );
    // 就地更新：只发过 1 次列表请求
    expect(getAlertsMock).toHaveBeenCalledTimes(1);
  });

  it('标记已读（只看未读）→ 该行从列表移除，不整页重拉', async () => {
    getAlertsMock.mockImplementation((params) =>
      echoPage({
        page: params?.page,
        items: [alertItem({ id: 1 }), alertItem({ id: 2, studentId: 12, studentName: '小红' })],
      }),
    );

    renderPage();
    await screen.findByTestId('alert-row-1');
    fireEvent.click(screen.getByRole('button', { name: '只看未读' }));
    await waitFor(() => expect(getAlertsMock).toHaveBeenLastCalledWith({ unreadOnly: true, page: 1 }));
    await screen.findByTestId('alert-row-1');
    const callsAfterToggle = getAlertsMock.mock.calls.length;

    fireEvent.click(
      within(screen.getByTestId('alert-row-1')).getByRole('button', { name: '标记已读' }),
    );

    await waitFor(() => expect(screen.queryByTestId('alert-row-1')).not.toBeInTheDocument());
    expect(screen.getByTestId('alert-row-2')).toBeInTheDocument();
    expect(getAlertsMock.mock.calls.length).toBe(callsAfterToggle);
  });

  it('标记已读失败 → toast(error)，该行仍显示「标记已读」', async () => {
    getAlertsMock.mockResolvedValue(pageOf([alertItem()]));
    markReadMock.mockRejectedValue(new ApiError(1005, '无权操作该预警'));

    renderPage();
    const row = await screen.findByTestId('alert-row-1');
    fireEvent.click(within(row).getByRole('button', { name: '标记已读' }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '无权操作该预警'));
    expect(
      within(screen.getByTestId('alert-row-1')).getByRole('button', { name: '标记已读' }),
    ).toBeInTheDocument();
  });

  /**
   * 「共 N 条」必须跟着就地更新一起减（2026-09-20 评审 Important-2）。
   *
   * 为什么单独钉：原先只断言「行被摘掉」，把 `total: prev.value.total - removed` 改成
   * `total: prev.value.total`（即完全不减）后**全套 13 条用例照样全绿** ——
   * 头部计数会一直显示清理前的数字，家长以为还有那么多条没读。
   */
  it('标记已读（只看未读）→ 「共 N 条」同步递减', async () => {
    getAlertsMock.mockImplementation(() =>
      echoPage({ items: [alertItem({ id: 1 }), alertItem({ id: 2 })], total: 5 }),
    );

    renderPage();
    await screen.findByTestId('alert-row-1');
    fireEvent.click(screen.getByRole('button', { name: '只看未读' }));
    await waitFor(() => expect(getAlertsMock).toHaveBeenLastCalledWith({ unreadOnly: true, page: 1 }));

    expect(await screen.findByText('共 5 条')).toBeInTheDocument();

    fireEvent.click(
      within(screen.getByTestId('alert-row-1')).getByRole('button', { name: '标记已读' }),
    );

    // 摘掉一行 → 总数从 5 减到 4（不是只摘行、计数不动）
    expect(await screen.findByText('共 4 条')).toBeInTheDocument();
  });

  /**
   * 「只看未读」下摘掉**本页最后一条** → 必须回上一页，不能停在假空态（2026-09-20 评审 Important-1）。
   *
   * 为什么这是真 bug：`Pagination` 只在非空分支渲染，且 `page` 没变就不会重拉。于是
   * 家长在第 2 页摘掉唯一那条后，看到的是「当前筛选下没有预警」——**而第 1 页还有 20 条未读**，
   * 且没有任何翻页控件能回去，只剩「清除筛选」（会把筛选一起丢掉）。CLAUDE.md 记过同类陷阱。
   */
  it('「只看未读」下标记本页最后一条 → 回上一页重拉，不停在假空态', async () => {
    getAlertsMock.mockImplementation((params) =>
      params?.page === 2
        ? echoPage({ page: 2, total: 21, items: [alertItem({ id: 21 })] })
        : echoPage({ page: params?.page ?? 1, total: 21 }),
    );

    renderPage();
    await screen.findByTestId('alert-row-1');
    fireEvent.click(screen.getByRole('button', { name: '只看未读' }));
    await waitFor(() =>
      expect(getAlertsMock).toHaveBeenLastCalledWith({ unreadOnly: true, page: 1 }),
    );

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() =>
      expect(getAlertsMock).toHaveBeenLastCalledWith({ unreadOnly: true, page: 2 }),
    );
    const row = await screen.findByTestId('alert-row-21');

    fireEvent.click(within(row).getByRole('button', { name: '标记已读' }));

    // 自动回第 1 页并重拉（而不是停在「当前筛选下没有预警」）
    await waitFor(() =>
      expect(getAlertsMock).toHaveBeenLastCalledWith({ unreadOnly: true, page: 1 }),
    );
    expect(screen.queryByText('当前筛选下没有预警')).not.toBeInTheDocument();
    expect(await screen.findByTestId('alert-row-1')).toBeInTheDocument();
  });

  /**
   * PATCH 在途时切筛选 → 判定必须用**数据自身的口径**，不是发起时的闭包值（2026-09-20 评审 Minor-1）。
   *
   * 竞态：点「标记已读」时 `unreadOnly=false`，PATCH 还没回来家长就切了「只看未读」。
   * 此时 `prev` 已是未读口径的数据，若仍按闭包里的旧口径走「标记成 isRead:true」分支，
   * 一条**服务端已判为已读**的行会留在「只看未读」列表里 —— 筛选语义被破坏。
   */
  it('标记已读在途时切「只看未读」→ 该行被摘掉，不得留在未读列表里', async () => {
    getAlertsMock.mockImplementation((params) =>
      params?.unreadOnly
        ? echoPage({ items: [alertItem({ id: 1 })], total: 1 })
        : echoPage({
            items: [alertItem({ id: 1 }), alertItem({ id: 2, isRead: true })],
            total: 2,
          }),
    );
    let releaseMark!: () => void;
    markReadMock.mockReturnValue(
      // `markParentAlertRead` 的返回类型是 `Promise<null>`，这里必须同型（tsc 会拦）
      new Promise<null>((resolve) => {
        releaseMark = () => resolve(null);
      }),
    );

    renderPage();
    const row = await screen.findByTestId('alert-row-1');
    fireEvent.click(within(row).getByRole('button', { name: '标记已读' }));
    await waitFor(() => expect(markReadMock).toHaveBeenCalledWith(1));

    // PATCH 仍在途：切「只看未读」，服务端只回未读那条
    fireEvent.click(screen.getByRole('button', { name: '只看未读' }));
    await waitFor(() =>
      expect(getAlertsMock).toHaveBeenLastCalledWith({ unreadOnly: true, page: 1 }),
    );
    expect(await screen.findByTestId('alert-row-1')).toBeInTheDocument();

    // 放行 PATCH：此时必须按「未读口径」把它摘掉
    releaseMark();

    await waitFor(() => expect(screen.queryByTestId('alert-row-1')).not.toBeInTheDocument());
  });

  it('换孩子 → 回第 1 页并带上孩子筛选重拉', async () => {
    getAlertsMock.mockImplementation((params) => echoPage({ page: params?.page, total: 25 }));

    renderPage();
    await screen.findByTestId('alert-row-1');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(getAlertsMock).toHaveBeenLastCalledWith({ page: 2 }));

    fireEvent.change(screen.getByLabelText('孩子'), { target: { value: '11' } });

    await waitFor(() => expect(getAlertsMock).toHaveBeenLastCalledWith({ studentId: 11, page: 1 }));
  });

  it('切「只看未读」→ 回第 1 页', async () => {
    getAlertsMock.mockImplementation((params) => echoPage({ page: params?.page, total: 25 }));

    renderPage();
    await screen.findByTestId('alert-row-1');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(getAlertsMock).toHaveBeenLastCalledWith({ page: 2 }));

    fireEvent.click(screen.getByRole('button', { name: '只看未读' }));

    await waitFor(() =>
      expect(getAlertsMock).toHaveBeenLastCalledWith({ unreadOnly: true, page: 1 }),
    );
  });

  it('换孩子后、新请求未回来前，不得继续显示上一个筛选的数据（派生状态带归属）', async () => {
    getAlertsMock.mockResolvedValueOnce(pageOf([alertItem({ message: '小明的预警' })]));

    renderPage();
    expect(await screen.findByText('小明的预警')).toBeInTheDocument();

    // 切到小红：新请求挂起不返回
    getAlertsMock.mockImplementation(() => new Promise(() => {}));
    fireEvent.change(screen.getByLabelText('孩子'), { target: { value: '12' } });

    // 若不按请求参数归属过滤，此刻会拿「小明的预警」渲染给小红的筛选结果
    await waitFor(() => expect(screen.queryByText('小明的预警')).not.toBeInTheDocument());
  });
});
