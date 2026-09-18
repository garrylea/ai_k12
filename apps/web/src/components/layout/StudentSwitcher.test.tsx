import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { StudentSwitcher } from './StudentSwitcher';
import { listMyStudents, type MyStudentItem } from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

/**
 * 家长端顶栏「当前查看的孩子」下拉（计划三 §2.2）。
 *
 * 这里钉住的是**回落逻辑**——它只写在这一处，`ParentLayout` 不会再拉一次
 * `listMyStudents()`：
 * 1. 0 个孩子 → 空态 + 去「学生账号」的链接，**不渲染下拉**；
 * 2. 持久化的 id 失效（换账号 / 孩子被删 / 上个家长残留）→ 回落第一个；
 * 3. 首次进（`studentId === null`）→ 默认选第一个；
 * 4. 拉取失败 → 可重试的轻量错误态，不把顶栏搞崩；
 * 5. **`pathname` 变化 → 重拉**（组件挂在顶栏、不随子路由重挂载，只依赖 `load`
 *    会导致「新建完孩子跳页，顶栏还写着还没有孩子账号」，见下方承重用例）；
 * 6. **有数据时静默刷新**：`pathname` 变化触发的重拉，若手上已有列表则**不出骨架**，
 *    旧列表全程可见，拿到结果再替换；静默刷新失败也保留旧列表、不进错误态。
 *    只有首次加载（以及首次失败后的重试）才出骨架——错误态同理只属于**首次**失败。
 *
 * 另有两条有意为之：
 * - **1 个孩子也照常渲染下拉**（P6.8 多孩切换的可扩展性，布局不抖）；
 * - **不显示段位图标**——每个孩子都要各拉一次积分概览，N 个孩子 N 次请求，
 *   为顶栏一个小图标不值得（见组件注释，别当成漏了）。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, listMyStudents: vi.fn() };
});

const listMyStudentsMock = vi.mocked(listMyStudents);

function student(over: Partial<MyStudentItem> & { id: number }): MyStudentItem {
  return {
    parentId: 1,
    username: `student${over.id}`,
    name: '孩子',
    age: null,
    grade: null,
    schoolLevel: null,
    isActive: true,
    ...over,
  };
}

const MING = student({ id: 1, name: '小明', grade: '三年级' });
const HONG = student({ id: 2, name: '小红', grade: '初一' });

function renderSwitcher() {
  return render(
    <MemoryRouter>
      <StudentSwitcher />
    </MemoryRouter>,
  );
}

/** 只负责触发**真路由导航**的按钮：导航后 pathname 变，但组件不重挂载。 */
function NavProbe({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      {label}
    </button>
  );
}

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: null });
  listMyStudentsMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  localStorage.clear();
});

describe('StudentSwitcher', () => {
  it('只有 1 个孩子也渲染下拉，并显示真实名字 + 年级', async () => {
    listMyStudentsMock.mockResolvedValue([MING]);

    renderSwitcher();

    const trigger = await screen.findByTestId('student-switcher-trigger');
    expect(trigger).toHaveTextContent('小明');
    expect(trigger).toHaveTextContent('（三年级）');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // 有孩子才有「当前查看：」这个前缀标签（空态/错误态刻意不渲染它，见下方用例）
    expect(screen.getByText('当前查看：')).toBeInTheDocument();
    // 没有年级时不编一个出来
    expect(trigger).not.toHaveTextContent('（null）');
  });

  it('点开菜单列出全部孩子，点某个孩子 → setStudentId(id) 且菜单关闭', async () => {
    const user = userEvent.setup();
    listMyStudentsMock.mockResolvedValue([MING, HONG]);
    const spy = vi.spyOn(useParentStudentStore.getState(), 'setStudentId');

    renderSwitcher();

    const trigger = await screen.findByTestId('student-switcher-trigger');
    await waitFor(() => expect(trigger).toHaveTextContent('小明')); // 默认选第一个

    await user.click(trigger);
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('student-option-1')).toBeInTheDocument();
    expect(screen.getByTestId('student-option-2')).toBeInTheDocument();

    await user.click(screen.getByTestId('student-option-2'));

    expect(spy).toHaveBeenCalledWith(2);
    expect(useParentStudentStore.getState().studentId).toBe(2);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent('小红');
  });

  it('点外部关闭菜单', async () => {
    const user = userEvent.setup();
    listMyStudentsMock.mockResolvedValue([MING, HONG]);

    renderSwitcher();

    await user.click(await screen.findByTestId('student-switcher-trigger'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.click(document.body);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Esc 关闭菜单', async () => {
    const user = userEvent.setup();
    listMyStudentsMock.mockResolvedValue([MING, HONG]);

    renderSwitcher();

    await user.click(await screen.findByTestId('student-switcher-trigger'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('键盘可达：打开后焦点进入选中项，方向键移动，Enter 选中', async () => {
    const user = userEvent.setup();
    listMyStudentsMock.mockResolvedValue([MING, HONG]);

    renderSwitcher();

    const trigger = await screen.findByTestId('student-switcher-trigger');
    await waitFor(() => expect(trigger).toHaveTextContent('小明'));

    await user.click(trigger);
    await waitFor(() => expect(screen.getByTestId('student-option-1')).toHaveFocus());

    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('student-option-2')).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(useParentStudentStore.getState().studentId).toBe(2);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('0 个孩子 → 空态文案 + 链接 /parent/students，且没有下拉', async () => {
    listMyStudentsMock.mockResolvedValue([]);

    renderSwitcher();

    expect(await screen.findByText('还没有孩子账号')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /学生账号|去创建/ });
    expect(link).toHaveAttribute('href', '/parent/students');
    expect(screen.queryByTestId('student-switcher-trigger')).not.toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // 空态没有「当前」可言，不该读出「当前查看：还没有孩子账号」
    expect(screen.queryByText('当前查看：')).not.toBeInTheDocument();
    expect(useParentStudentStore.getState().studentId).toBeNull();
  });

  it('列表返回前渲染骨架，返回后换成下拉（钉住 student-switcher-loading）', async () => {
    let resolveList!: (list: MyStudentItem[]) => void;
    listMyStudentsMock.mockImplementation(
      () =>
        new Promise<MyStudentItem[]>((resolve) => {
          resolveList = resolve;
        }),
    );

    renderSwitcher();

    expect(screen.getByTestId('student-switcher-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('student-switcher-trigger')).not.toBeInTheDocument();

    await act(async () => resolveList([MING]));

    expect(await screen.findByTestId('student-switcher-trigger')).toHaveTextContent('小明');
    expect(screen.queryByTestId('student-switcher-loading')).not.toBeInTheDocument();
  });

  it('路由变化重拉时不出骨架：旧列表全程可见，拿到新列表再替换', async () => {
    const user = userEvent.setup();
    // 首屏正常出一次列表
    listMyStudentsMock.mockResolvedValueOnce([MING]);
    // 第二次（导航触发）挂起不 resolve，把「刷新中」这一帧定住
    let resolveSecond!: (list: MyStudentItem[]) => void;
    listMyStudentsMock.mockImplementationOnce(
      () =>
        new Promise<MyStudentItem[]>((resolve) => {
          resolveSecond = resolve;
        }),
    );

    render(
      <MemoryRouter initialEntries={['/parent/students']}>
        <StudentSwitcher />
        <NavProbe to="/parent/students/7/config" label="去孩子配置页" />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('student-switcher-trigger')).toHaveTextContent('小明');

    await user.click(screen.getByRole('button', { name: '去孩子配置页' }));

    await waitFor(() => expect(listMyStudentsMock).toHaveBeenCalledTimes(2));
    // 第二次请求在飞：不能出现骨架，旧列表名字仍在屏幕上
    expect(screen.queryByTestId('student-switcher-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('student-switcher-trigger')).toHaveTextContent('小明');

    // 结果回来后静默替换（选中的小明被删/换账号时仍走既有的回落校验）
    await act(async () => resolveSecond([HONG]));
    expect(await screen.findByTestId('student-switcher-trigger')).toHaveTextContent('小红');
    expect(useParentStudentStore.getState().studentId).toBe(2);
  });

  it('静默刷新失败 → 保留旧列表、不显示错误态；下一次导航仍会再试', async () => {
    const user = userEvent.setup();
    listMyStudentsMock.mockResolvedValueOnce([MING]);
    listMyStudentsMock.mockRejectedValueOnce(new Error('network down'));

    render(
      <MemoryRouter initialEntries={['/parent/students']}>
        <StudentSwitcher />
        <NavProbe to="/parent/students/7/config" label="去孩子配置页" />
        <NavProbe to="/parent/students/7/rewards" label="去奖励册" />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('student-switcher-trigger')).toHaveTextContent('小明');

    await user.click(screen.getByRole('button', { name: '去孩子配置页' }));

    await waitFor(() => expect(listMyStudentsMock).toHaveBeenCalledTimes(2));
    // 静默刷新失败：不清空、不进错误态、不闪骨架，锚点不动
    expect(await screen.findByTestId('student-switcher-trigger')).toHaveTextContent('小明');
    expect(screen.queryByText('孩子信息加载失败')).not.toBeInTheDocument();
    expect(screen.queryByText('还没有孩子账号')).not.toBeInTheDocument();
    expect(screen.queryByTestId('student-switcher-loading')).not.toBeInTheDocument();
    expect(useParentStudentStore.getState().studentId).toBe(1);

    // 下一次导航自动再试（不需要手动重试按钮）
    listMyStudentsMock.mockResolvedValueOnce([MING, HONG]);
    await user.click(screen.getByRole('button', { name: '去奖励册' }));

    await waitFor(() => expect(listMyStudentsMock).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId('student-switcher-trigger')).toHaveTextContent('小明');
  });

  it('pathname 变化时重拉列表：新建孩子后跳配置页，顶栏自愈（承重用例）', async () => {
    const user = userEvent.setup();
    // 家长还没有孩子 → 顶栏是空态
    listMyStudentsMock.mockResolvedValueOnce([]);

    render(
      <MemoryRouter initialEntries={['/parent/students']}>
        <StudentSwitcher />
        <NavProbe to="/parent/students/7/config" label="去孩子配置页" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('还没有孩子账号')).toBeInTheDocument();
    expect(listMyStudentsMock).toHaveBeenCalledTimes(1);

    // 家长刚在那一页建好孩子（服务端列表变了），随即跳到孩子的配置页。
    // 组件**没有重挂载**（同一个实例），只有 pathname 变了 —— 仍必须重拉。
    listMyStudentsMock.mockResolvedValueOnce([MING]);
    await user.click(screen.getByRole('button', { name: '去孩子配置页' }));

    await waitFor(() => expect(listMyStudentsMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('student-switcher-trigger')).toHaveTextContent('小明');
    expect(screen.queryByText('还没有孩子账号')).not.toBeInTheDocument();
  });

  it('持久化 id 已失效（换账号 / 被删）→ 回落到第一个孩子', async () => {
    listMyStudentsMock.mockResolvedValue([MING]);
    // 上个家长 / 已删除的孩子留下的残留 id
    useParentStudentStore.setState({ studentId: 99 });
    const spy = vi.spyOn(useParentStudentStore.getState(), 'setStudentId');

    renderSwitcher();

    await waitFor(() => expect(useParentStudentStore.getState().studentId).toBe(1));
    expect(spy).toHaveBeenCalledWith(1);
    expect(await screen.findByTestId('student-switcher-trigger')).toHaveTextContent('小明');
  });

  it('首次进家长端（studentId 为 null）→ 默认选第一个', async () => {
    listMyStudentsMock.mockResolvedValue([MING, HONG]);

    renderSwitcher();

    await waitFor(() => expect(useParentStudentStore.getState().studentId).toBe(1));
  });

  it('拉取失败 → 可重试的轻量错误态，不崩；重试成功后可正常切换', async () => {
    const user = userEvent.setup();
    listMyStudentsMock.mockRejectedValueOnce(new Error('network down'));

    renderSwitcher();

    expect(await screen.findByText('孩子信息加载失败')).toBeInTheDocument();
    expect(screen.queryByTestId('student-switcher-trigger')).not.toBeInTheDocument();

    listMyStudentsMock.mockResolvedValueOnce([MING]);
    await user.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByTestId('student-switcher-trigger')).toHaveTextContent('小明');
    expect(listMyStudentsMock).toHaveBeenCalledTimes(2);
  });
});
