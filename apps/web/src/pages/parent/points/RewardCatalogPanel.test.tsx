import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import RewardCatalogPanel, { type LeaveGuard } from './RewardCatalogPanel';
import { toast } from '@/components/base';
import {
  ApiError,
  getLevels,
  getParentRewardCatalog,
  saveParentRewardCatalog,
  type PointLevel,
  type RewardCatalogView,
} from '@/services/api';

/**
 * 家长端「奖励清单」管理（计划三 §2.5 / §3 Task 6）。
 *
 * 契约要点（每条都对应一个真实会坏的行为）：
 * 1. **整表 PUT 必须带回下架行的 `isActive: false`**——`RedemptionService.normalizeCatalogItem`
 *    对 `isActive` 缺省为 true，漏带 = 已下架的奖励被**静默重新上架**（计划 §1.1#3、
 *    计划一 Task 8 审查点名）。本文件里这条是**承重用例**。
 * 2. `id` 缺省 = 新增（服务端生成 id）；有 id = 更新；清单里消失的 id 由服务端**软删**，
 *    前端只负责「不带」。
 * 3. 保存成功后用**响应体**替换本地数组（id 由服务端回填），不自己拼。
 * 4. 空数组是合法语义（= 全部软删），但**必须先二次确认**。
 * 5. `minLevelCode` 只能来自 `getLevels()`（段位表单一真源在后端，前端不硬编码）。
 * 6. 排序用「上移/下移」按钮，`sortOrder` = 数组下标 × 10（家长看不到「排序号」）。
 * 7. `description` 空串提交 `null`（不是空串，也不是丢掉字段）。
 * 8. 未保存状态通过 `onRegisterLeaveGuard` 注册给页面（Tab 打点 + 切走确认）。
 */

/** 段位表 fixture：与后端 `levels.ts` 同 9 档（测试只关心条数与 name/code 透传）。 */
const LEVELS: PointLevel[] = [
  { code: 'pichai', name: '劈柴', index: 0, threshold: 0 },
  { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
  { code: 'qingtong', name: '青铜', index: 2, threshold: 1200 },
  { code: 'baiyin', name: '白银', index: 3, threshold: 2000 },
  { code: 'huangjin', name: '黄金', index: 4, threshold: 3000 },
  { code: 'bojin', name: '铂金', index: 5, threshold: 5000 },
  { code: 'zuanshi', name: '钻石', index: 6, threshold: 8000 },
  { code: 'xingyao', name: '星耀', index: 7, threshold: 12000 },
  { code: 'wangzhe', name: '王者', index: 8, threshold: 20000 },
];

/** 三条奖励，其中 `买一本漫画`（id 13）**已下架**——它必须照常渲染且被原样带回。 */
const CATALOG: RewardCatalogView[] = [
  {
    id: 11,
    name: '周末看电影',
    description: '和同学一起',
    pointsCost: 200,
    minLevelCode: 'baiyin',
    isActive: true,
    sortOrder: 0,
  },
  {
    id: 12,
    name: '多玩半小时游戏',
    description: null,
    pointsCost: 50,
    minLevelCode: null,
    isActive: true,
    sortOrder: 10,
  },
  {
    id: 13,
    name: '买一本漫画',
    description: '自选',
    pointsCost: 80,
    minLevelCode: null,
    isActive: false,
    sortOrder: 20,
  },
];

/** 服务端原样返回提交内容的缺省 mock 值（大多数用例不关心响应，只需要它别炸）。 */
function echo(items: RewardCatalogView[]): RewardCatalogView[] {
  return items;
}

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getLevels: vi.fn(),
    getParentRewardCatalog: vi.fn(),
    saveParentRewardCatalog: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const getLevelsMock = vi.mocked(getLevels);
const getCatalogMock = vi.mocked(getParentRewardCatalog);
const saveCatalogMock = vi.mocked(saveParentRewardCatalog);
const toastMock = vi.mocked(toast);

function renderPanel(studentId = 1) {
  return render(<RewardCatalogPanel studentId={studentId} />);
}

/** 带守卫注册通道渲染：`lastGuard()` 拿面板最新注册的守卫（卸载时注册 null）。 */
function renderWithGuard(studentId = 1) {
  const guards: (LeaveGuard | null)[] = [];
  const utils = render(
    <RewardCatalogPanel
      studentId={studentId}
      onRegisterLeaveGuard={(guard) => guards.push(guard)}
    />,
  );
  return { ...utils, lastGuard: () => guards[guards.length - 1] ?? null };
}

function row(id: number | string) {
  return screen.getByTestId(`reward-row-${id}`);
}

function rowOrder(): string[] {
  return screen
    .getAllByTestId(/^reward-row-/)
    .map((el) => (el.getAttribute('data-testid') ?? '').replace('reward-row-', ''));
}

/** 保存并按调用参数取回 `items`。 */
async function saveAndGetItems(): Promise<unknown> {
  fireEvent.click(screen.getByTestId('save-catalog'));
  await waitFor(() => expect(saveCatalogMock).toHaveBeenCalledTimes(1));
  return saveCatalogMock.mock.calls[0][1];
}

beforeEach(() => {
  getLevelsMock.mockReset();
  getCatalogMock.mockReset();
  saveCatalogMock.mockReset();
  toastMock.mockReset();
  getLevelsMock.mockResolvedValue({ levels: LEVELS });
  getCatalogMock.mockResolvedValue(CATALOG);
  saveCatalogMock.mockImplementation((_studentId, items) =>
    Promise.resolve(
      echo(
        items.map(
          (item, index): RewardCatalogView => ({
            id: item.id ?? 100 + index,
            name: item.name,
            description: item.description,
            pointsCost: item.pointsCost,
            minLevelCode: item.minLevelCode,
            isActive: item.isActive,
            sortOrder: item.sortOrder,
          }),
        ),
      ),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RewardCatalogPanel：渲染', () => {
  it('渲染清单与三行，下架行照常出现且有「已下架」标签', async () => {
    renderPanel();

    await screen.findByTestId('reward-row-11');
    expect(getCatalogMock).toHaveBeenCalledWith(1);
    expect(rowOrder()).toEqual(['11', '12', '13']);

    const down = row(13);
    expect(within(down).getByText('已下架')).toBeInTheDocument();
    expect(within(down).getByLabelText('名称')).toHaveValue('买一本漫画');
    // 上架行不带标识
    expect(within(row(11)).queryByText('已下架')).not.toBeInTheDocument();
  });

  it('段位下拉项来自 getLevels()：「无门槛」+ 9 个段位', async () => {
    renderPanel();

    const first = await screen.findByTestId('reward-row-11');
    expect(getLevelsMock).toHaveBeenCalledTimes(1);

    const select = within(first).getByLabelText('最低段位');
    expect(select).toHaveValue('baiyin');

    const options = within(select).getAllByRole('option');
    expect(options).toHaveLength(10);
    expect(within(select).getByRole('option', { name: '无门槛' })).toHaveValue('');
    // 9 个段位 option（排除「无门槛」）
    const levelOptions = options.filter((o) => o.getAttribute('value') !== '');
    expect(levelOptions).toHaveLength(9);
    expect(levelOptions.map((o) => o.textContent)).toEqual(LEVELS.map((l) => l.name));
  });

  it('加载中给骨架；加载失败给可重试的错误态', async () => {
    getCatalogMock.mockReturnValue(new Promise<RewardCatalogView[]>(() => {}));

    renderPanel();

    expect(screen.getByTestId('reward-catalog-skeleton')).toBeInTheDocument();
  });

  it('加载失败 → 错误态 + 「重试」重新拉取', async () => {
    getCatalogMock.mockRejectedValueOnce(new Error('boom'));

    renderPanel();

    const errorBox = await screen.findByTestId('reward-catalog-error');
    getCatalogMock.mockResolvedValueOnce(CATALOG);
    fireEvent.click(within(errorBox).getByRole('button', { name: '重试' }));

    expect(await screen.findByTestId('reward-row-11')).toBeInTheDocument();
    expect(getCatalogMock).toHaveBeenCalledTimes(2);
  });

  it('data-student-id 落在面板根元素上（骨架/错误/正常三态都在）', async () => {
    getCatalogMock.mockReturnValue(new Promise<RewardCatalogView[]>(() => {}));
    const skeletonRender = renderPanel(7);
    expect(skeletonRender.container.firstChild).toHaveAttribute('data-student-id', '7');
    skeletonRender.unmount();

    getCatalogMock.mockRejectedValueOnce(new Error('boom'));
    const errorRender = renderPanel(7);
    const errorBox = await screen.findByTestId('reward-catalog-error');
    expect(errorRender.container.firstChild).toBe(errorBox);
    expect(errorBox).toHaveAttribute('data-student-id', '7');
    errorRender.unmount();
  });
});

describe('RewardCatalogPanel：整表保存', () => {
  /**
   * **承重用例**（计划 §1.1#3）：保存时必须把当前列表原样整表提交，含已下架行的
   * `isActive: false`。若实现改成「只发改动的行」或「isActive 读服务端原值 / 干脆不带」，
   * 服务端 `normalizeCatalogItem` 会把缺省的 isActive 当 true → 已下架奖励被静默重新上架。
   */
  it('保存 body 含全部行，且下架行确实带 isActive:false', async () => {
    renderPanel();

    const first = await screen.findByTestId('reward-row-11');
    // 只改一行的分值，仍须整表提交
    fireEvent.change(within(first).getByLabelText('所需积分'), { target: { value: '300' } });

    const items = (await saveAndGetItems()) as Array<Record<string, unknown>>;

    expect(items).toHaveLength(3);
    expect(items.map((i) => i.id)).toEqual([11, 12, 13]);
    // 下架行原样带回（显式字段断言：漏字段 / 缺省 true 都会被这里钉住）
    const offline = items.find((i) => i.id === 13);
    expect(offline).toEqual({
      id: 13,
      name: '买一本漫画',
      description: '自选',
      pointsCost: 80,
      minLevelCode: null,
      isActive: false,
      sortOrder: 20,
    });
  });

  it('新增一行 → 本地出现新行；保存时 items 多一条且新行没有 id', async () => {
    renderPanel();

    await screen.findByTestId('reward-row-11');
    fireEvent.click(screen.getByTestId('add-reward'));

    const fresh = screen.getByTestId('reward-row-new-1');
    fireEvent.change(within(fresh).getByLabelText('名称'), { target: { value: '去游乐园' } });
    fireEvent.change(within(fresh).getByLabelText('所需积分'), { target: { value: '500' } });
    // 还没落库，保存按钮先变可点
    expect(screen.getByTestId('save-catalog')).toBeEnabled();

    const items = (await saveAndGetItems()) as Array<Record<string, unknown>>;

    expect(items).toHaveLength(4);
    const added = items[3];
    expect(added).not.toHaveProperty('id');
    expect(added).toEqual({
      name: '去游乐园',
      description: null,
      pointsCost: 500,
      minLevelCode: null,
      isActive: true,
      sortOrder: 30,
    });
    // 老行原样带出
    expect(items.map((i) => i.id).slice(0, 3)).toEqual([11, 12, 13]);
  });

  it('删除一行 → 保存时 items 里没有该 id（软删语义在服务端，前端只负责不带）', async () => {
    renderPanel();

    await screen.findByTestId('reward-row-12');
    fireEvent.click(within(row(12)).getByRole('button', { name: '删除' }));

    expect(screen.queryByTestId('reward-row-12')).not.toBeInTheDocument();

    const items = (await saveAndGetItems()) as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toEqual([11, 13]);
    expect(items.some((i) => i.id === 12)).toBe(false);
  });

  it('保存成功后用响应体替换本地数组：新行拿到服务端 id 与归一后的值', async () => {
    renderPanel();

    await screen.findByTestId('reward-row-11');
    fireEvent.click(screen.getByTestId('add-reward'));
    const fresh = screen.getByTestId('reward-row-new-1');
    // 故意带尾空格：服务端会 trim，回来时应展示归一后的值（证明用的是响应体）
    fireEvent.change(within(fresh).getByLabelText('名称'), { target: { value: '去游乐园 ' } });
    fireEvent.change(within(fresh).getByLabelText('所需积分'), { target: { value: '500' } });

    saveCatalogMock.mockResolvedValueOnce([
      ...CATALOG,
      {
        id: 42,
        name: '去游乐园',
        description: null,
        pointsCost: 500,
        minLevelCode: null,
        isActive: true,
        sortOrder: 30,
      },
    ]);

    fireEvent.click(screen.getByTestId('save-catalog'));

    const saved = await screen.findByTestId('reward-row-42');
    expect(within(saved).getByLabelText('名称')).toHaveValue('去游乐园');
    // 临时行没了，id 由服务端回填；且已对齐快照 → 保存重新 disabled
    expect(screen.queryByTestId('reward-row-new-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('save-catalog')).toBeDisabled();
    expect(toastMock).toHaveBeenCalledWith('success', '奖励清单已保存');
  });

  it('description 清空 → 提交 null（不是空串）', async () => {
    renderPanel();

    const first = await screen.findByTestId('reward-row-11');
    expect(within(first).getByLabelText('说明')).toHaveValue('和同学一起');
    fireEvent.change(within(first).getByLabelText('说明'), { target: { value: '' } });

    const items = (await saveAndGetItems()) as Array<Record<string, unknown>>;
    expect(items[0].description).toBeNull();
  });

  it('下架开关：切到 false 后保存，该行 isActive 进 body', async () => {
    renderPanel();

    const first = await screen.findByTestId('reward-row-11');
    const toggle = within(first).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(within(first).getByText('已下架')).toBeInTheDocument();

    const items = (await saveAndGetItems()) as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ id: 11, isActive: false });
  });

  it('上移/下移只改顺序：保存时 sortOrder = 新下标 × 10', async () => {
    renderPanel();

    await screen.findByTestId('reward-row-11');
    // 首行「上移」、末行「下移」不可点（没有可换的对象）
    expect(within(row(11)).getByRole('button', { name: '上移' })).toBeDisabled();
    expect(within(row(13)).getByRole('button', { name: '下移' })).toBeDisabled();

    fireEvent.click(within(row(11)).getByRole('button', { name: '下移' }));

    expect(rowOrder()).toEqual(['12', '11', '13']);
    // 位移后边界跟着换
    expect(within(row(12)).getByRole('button', { name: '上移' })).toBeDisabled();
    expect(within(row(13)).getByRole('button', { name: '下移' })).toBeDisabled();

    const items = (await saveAndGetItems()) as Array<Record<string, unknown>>;
    expect(items.map((i) => [i.id, i.sortOrder])).toEqual([
      [12, 0],
      [11, 10],
      [13, 20],
    ]);
  });

  it('空清单保存：先弹确认；未确认不发请求，确认后才发 {items: []}', async () => {
    renderPanel();

    await screen.findByTestId('reward-row-11');
    for (const id of [11, 12, 13]) {
      fireEvent.click(within(row(id)).getByRole('button', { name: '删除' }));
    }
    expect(screen.getByText('还没有奖励')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('save-catalog'));

    expect(await screen.findByText(/将清空全部奖励，孩子端奖励册会变空/)).toBeInTheDocument();
    expect(saveCatalogMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));

    await waitFor(() => expect(saveCatalogMock).toHaveBeenCalledWith(1, []));
  });

  it('空清单确认弹窗可以取消：不发请求、本地仍为空清单', async () => {
    renderPanel();

    await screen.findByTestId('reward-row-11');
    for (const id of [11, 12, 13]) {
      fireEvent.click(within(row(id)).getByRole('button', { name: '删除' }));
    }
    fireEvent.click(screen.getByTestId('save-catalog'));
    await screen.findByText(/将清空全部奖励，孩子端奖励册会变空/);

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(saveCatalogMock).not.toHaveBeenCalled();
    // Modal 走 AnimatePresence 退出动画，消失要等一下
    await waitFor(() => expect(screen.queryByText(/将清空全部奖励/)).not.toBeInTheDocument());
    expect(screen.getByTestId('save-catalog')).toBeEnabled();
  });
});

describe('RewardCatalogPanel：校验与错误', () => {
  it('名称清空 → 行内报错 + 保存禁用 + 不发请求', async () => {
    renderPanel();

    const first = await screen.findByTestId('reward-row-11');
    fireEvent.change(within(first).getByLabelText('名称'), { target: { value: '' } });

    expect(within(first).getByText('请填 1–100 个字符')).toBeInTheDocument();
    const save = screen.getByTestId('save-catalog');
    expect(save).toBeDisabled();

    fireEvent.click(save);
    expect(saveCatalogMock).not.toHaveBeenCalled();
  });

  it('所需积分越界（0 / 999999+1）→ 行内报错 + 保存禁用', async () => {
    renderPanel();

    const first = await screen.findByTestId('reward-row-11');
    const cost = within(first).getByLabelText('所需积分');

    fireEvent.change(cost, { target: { value: '0' } });
    expect(within(first).getByText('请填 1–999999 的整数')).toBeInTheDocument();
    expect(screen.getByTestId('save-catalog')).toBeDisabled();

    fireEvent.change(cost, { target: { value: '1000000' } });
    expect(within(first).getByText('请填 1–999999 的整数')).toBeInTheDocument();
    expect(screen.getByTestId('save-catalog')).toBeDisabled();

    fireEvent.change(cost, { target: { value: '300' } });
    expect(within(first).queryByText('请填 1–999999 的整数')).not.toBeInTheDocument();
    expect(screen.getByTestId('save-catalog')).toBeEnabled();
  });

  it('后端 1001 → 行内字段提示（不发 toast）', async () => {
    renderPanel();

    const first = await screen.findByTestId('reward-row-11');
    fireEvent.change(within(first).getByLabelText('所需积分'), { target: { value: '300' } });
    saveCatalogMock.mockRejectedValueOnce(
      new ApiError(1001, '入参校验失败：items.0.pointsCost: Number must be less than or equal to 999999'),
    );

    fireEvent.click(screen.getByTestId('save-catalog'));

    expect(await screen.findByText(/积分不符合服务端要求/)).toBeInTheDocument();
    expect(toastMock).not.toHaveBeenCalled();
    // 草稿还在，可以改完重存
    expect(within(first).getByLabelText('所需积分')).toHaveValue(300);
  });

  it('后端 1001 但错误不属于任何字段（如 id 失效）→ 表单级提示，不发 toast', async () => {
    renderPanel();

    const first = await screen.findByTestId('reward-row-11');
    fireEvent.change(within(first).getByLabelText('所需积分'), { target: { value: '300' } });
    saveCatalogMock.mockRejectedValueOnce(
      new ApiError(1001, '奖励不存在或不属于该学生（id=11）'),
    );

    fireEvent.click(screen.getByTestId('save-catalog'));

    expect(await screen.findByTestId('reward-catalog-save-error')).toHaveTextContent(
      '奖励不存在或不属于该学生（id=11）',
    );
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('其它错误（500 / 网络）→ toast 报错', async () => {
    renderPanel();

    const first = await screen.findByTestId('reward-row-11');
    fireEvent.change(within(first).getByLabelText('所需积分'), { target: { value: '300' } });
    saveCatalogMock.mockRejectedValueOnce(new ApiError(5000, '服务端开小差了'));

    fireEvent.click(screen.getByTestId('save-catalog'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '服务端开小差了'));
    expect(screen.queryByTestId('reward-catalog-save-error')).not.toBeInTheDocument();
  });
});

describe('RewardCatalogPanel：未保存守卫通道', () => {
  it('干净时注册的守卫 dirty=false；改动后重新注册为 true', async () => {
    const { lastGuard } = renderWithGuard();

    const first = await screen.findByTestId('reward-row-11');
    await waitFor(() => expect(lastGuard()).not.toBeNull());
    expect(lastGuard()?.dirty).toBe(false);

    fireEvent.change(within(first).getByLabelText('所需积分'), { target: { value: '300' } });

    await waitFor(() => expect(lastGuard()?.dirty).toBe(true));
  });

  it('confirmLeave 弹确认：取消走 onCancelled，确认走 onConfirmed', async () => {
    const { lastGuard } = renderWithGuard();

    const first = await screen.findByTestId('reward-row-11');
    fireEvent.change(within(first).getByLabelText('所需积分'), { target: { value: '300' } });
    await waitFor(() => expect(lastGuard()?.dirty).toBe(true));

    const onConfirmed = vi.fn();
    const onCancelled = vi.fn();
    act(() => lastGuard()?.confirmLeave(onConfirmed, onCancelled));

    expect(await screen.findByText(/有未保存的修改，确定离开吗/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(onConfirmed).not.toHaveBeenCalled();
    // 取消后草稿还在
    expect(within(first).getByLabelText('所需积分')).toHaveValue(300);

    act(() => lastGuard()?.confirmLeave(onConfirmed, onCancelled));
    fireEvent.click(await screen.findByRole('button', { name: '确认离开' }));
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it('卸载时注册 null（不留悬空回调）', async () => {
    const { lastGuard, unmount } = renderWithGuard();

    await screen.findByTestId('reward-row-11');
    unmount();

    expect(lastGuard()).toBeNull();
  });
});
