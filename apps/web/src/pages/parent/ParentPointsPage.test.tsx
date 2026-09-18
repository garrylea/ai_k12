import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ParentPointsPage from './ParentPointsPage';
import {
  getLevels,
  getParentPointRules,
  getParentPoints,
  getParentRewardCatalog,
  saveParentRewardCatalog,
  type MyPoints,
  type PointLevel,
  type RewardCatalogView,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

/**
 * 家长端积分页骨架（计划三 §2.3 / §3 Task 4）+ 未保存草稿保护（Task 6）。
 *
 * 契约要点：
 * 1. Tab 走 `?tab=` 深链，四档 `rules`（默认）/`catalog`/`redeem`/`history`；
 *    未知或缺失一律归一成 `rules`——不报错、不空页；
 * 2. 概览卡常驻 Tab 之上；**加载中必须是骨架**，绝不先渲染「劈柴 0 分」再跳真实值
 *    （孩子/家长会以为积分归零）；
 * 3. 概览失败给内联错误条 + 「重试」，**不整页白屏**（Tab 仍在）；
 * 4. `studentId === null` → 页面空态（不是骨架、也不崩），引导去 `/parent/students`；
 * 5. 切孩子 → 全部数据重拉（`getParentPoints` 以新 id 再调），且**不拿上一个孩子的
 *    分数顶替**（立即退回骨架）；面板按 `studentId` 重挂载 = 丢弃草稿的机制；
 * 6. **面板脏 → 切 Tab / 切孩子先弹确认**（Task 6）：取消要留在原地且草稿还在
 *    （面板是按 Tab 条件渲染的，只有页面能拦住这次卸载）。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getParentPoints: vi.fn(),
    getParentPointRules: vi.fn(),
    getParentRewardCatalog: vi.fn(),
    getLevels: vi.fn(),
    saveParentRewardCatalog: vi.fn(),
  };
});

const getParentPointsMock = vi.mocked(getParentPoints);
const getParentPointRulesMock = vi.mocked(getParentPointRules);
const getParentRewardCatalogMock = vi.mocked(getParentRewardCatalog);
const getLevelsMock = vi.mocked(getLevels);
const saveParentRewardCatalogMock = vi.mocked(saveParentRewardCatalog);

const POINTS: MyPoints = {
  balance: 120,
  totalEarned: 520,
  todayEarned: 10,
  level: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
  nextLevel: { code: 'qingtong', name: '青铜', index: 2, threshold: 1200 },
  pointsToNextLevel: 680,
  progressPercent: 2,
};

const MAXED: MyPoints = {
  balance: 21000,
  totalEarned: 21000,
  todayEarned: 0,
  level: { code: 'wangzhe', name: '王者', index: 8, threshold: 20000 },
  nextLevel: null,
  pointsToNextLevel: null,
  progressPercent: 100,
};

/** 「奖励清单」Tab 现在是真的面板：它自己会拉清单与段位表，本文件给最小可用数据。 */
const CATALOG: RewardCatalogView[] = [
  {
    id: 11,
    name: '周末看电影',
    description: '和同学一起',
    pointsCost: 200,
    minLevelCode: null,
    isActive: true,
    sortOrder: 0,
  },
];

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

function renderPage(path = '/parent/rewards') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ParentPointsPage />
    </MemoryRouter>,
  );
}

function switchStudent(id: number) {
  act(() => {
    useParentStudentStore.setState({ studentId: id });
  });
}

/** 手动控制 resolve 时机，用来制造「上一个孩子的响应迟到」。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: 1 });
  getParentPointsMock.mockReset();
  getParentPointsMock.mockResolvedValue(POINTS);
  // Task 5 起「积分规则」面板是真的组件：它自己会拉 rules。本文件只测页面骨架，
  // 给它一个空清单即可，否则真实 fetch 失败会让面板渲染出**第二个**「重试」按钮，
  // 与概览卡的重试撞名。
  getParentPointRulesMock.mockReset();
  getParentPointRulesMock.mockResolvedValue({ tasks: [] });
  getParentRewardCatalogMock.mockReset();
  getParentRewardCatalogMock.mockResolvedValue(CATALOG);
  getLevelsMock.mockReset();
  getLevelsMock.mockResolvedValue({ levels: LEVELS });
  saveParentRewardCatalogMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  localStorage.clear();
});

describe('ParentPointsPage：Tab 深链', () => {
  it('无 tab 参数时默认渲染「积分规则」', () => {
    renderPage();

    const tab = screen.getByRole('tab', { name: '积分规则' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('points-panel-rules')).toBeInTheDocument();
    expect(screen.queryByTestId('points-panel-catalog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('points-panel-redeem')).not.toBeInTheDocument();
    expect(screen.queryByTestId('points-panel-history')).not.toBeInTheDocument();
  });

  it('非法 tab=xyz 归一成「积分规则」，不报错、不空页', () => {
    renderPage('/parent/rewards?tab=xyz');

    expect(screen.getByRole('tab', { name: '积分规则' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('points-panel-rules')).toBeInTheDocument();
  });

  it('?tab=catalog 深链直接渲染「奖励清单」', () => {
    renderPage('/parent/rewards?tab=catalog');

    expect(screen.getByRole('tab', { name: '奖励清单' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('points-panel-catalog')).toBeInTheDocument();
    expect(screen.queryByTestId('points-panel-rules')).not.toBeInTheDocument();
  });

  it('点「兑换记录」切换 Tab 并写入 ?tab=history', () => {
    renderPage();

    fireEvent.click(screen.getByRole('tab', { name: '兑换记录' }));

    expect(screen.getByTestId('points-panel-history')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '兑换记录' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('ParentPointsPage：概览卡', () => {
  it('加载中渲染骨架，且页面文本里不出现「0 分」', () => {
    getParentPointsMock.mockReturnValue(new Promise<MyPoints>(() => {}));

    renderPage();

    expect(screen.getByTestId('points-overview-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('points-overview')).not.toBeInTheDocument();
    expect(screen.queryByText('0 分')).not.toBeInTheDocument();
    // 段位名也不该提前亮相（没有数据就没有段位）
    expect(screen.queryByText('劈柴')).not.toBeInTheDocument();
    expect(getParentPointsMock).toHaveBeenCalledWith(1);
  });

  it('就绪后显示段位名、可用/累计/今日与「距下一档还差 N 分」', async () => {
    renderPage();

    expect(await screen.findByTestId('points-overview')).toBeInTheDocument();
    expect(screen.getByText('铸铁')).toBeInTheDocument();
    expect(screen.getByText('可用积分')).toBeInTheDocument();
    expect(screen.getByText('累计积分')).toBeInTheDocument();
    expect(screen.getByText('今日获得')).toBeInTheDocument();
    expect(screen.getByText('120 分')).toBeInTheDocument();
    expect(screen.getByText('520 分')).toBeInTheDocument();
    expect(screen.getByText('10 分')).toBeInTheDocument();
    expect(screen.getByText(/距下一档还差 680 分/)).toBeInTheDocument();
    expect(screen.queryByTestId('points-overview-skeleton')).not.toBeInTheDocument();

    // 段位图标是真的 svg（只断言外层 span 等于没断言）
    expect(screen.getByTestId('points-overview-level-icon').querySelector('svg')).not.toBeNull();
  });

  it('满级（nextLevel === null）显示「已达最高段位」且不含「还差」', async () => {
    getParentPointsMock.mockResolvedValue(MAXED);

    renderPage();

    expect(await screen.findByText('王者')).toBeInTheDocument();
    expect(screen.getByText('已达最高段位')).toBeInTheDocument();
    expect(screen.queryByText(/还差/)).not.toBeInTheDocument();
  });

  it('概览请求失败 → 内联错误条 + 「重试」，点重试重新拉取', async () => {
    getParentPointsMock.mockRejectedValueOnce(new Error('boom'));

    renderPage();

    expect(await screen.findByTestId('points-overview-error')).toBeInTheDocument();
    // 不是整页白屏：Tab 与面板仍在
    expect(screen.getByRole('tab', { name: '积分规则' })).toBeInTheDocument();
    expect(screen.getByTestId('points-panel-rules')).toBeInTheDocument();

    getParentPointsMock.mockResolvedValueOnce(POINTS);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByTestId('points-overview')).toBeInTheDocument();
    expect(screen.getByText('铸铁')).toBeInTheDocument();
    expect(screen.queryByTestId('points-overview-error')).not.toBeInTheDocument();
    expect(getParentPointsMock).toHaveBeenCalledTimes(2);
    expect(getParentPointsMock).toHaveBeenLastCalledWith(1);
  });
});

describe('ParentPointsPage：孩子上下文', () => {
  it('studentId 为 null 时渲染空态（不是骨架，也不崩），并引导去创建账号', () => {
    useParentStudentStore.setState({ studentId: null });

    renderPage();

    expect(screen.getByTestId('points-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('points-overview-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '去创建学生账号' })).toHaveAttribute(
      'href',
      '/parent/students',
    );
    // 没有孩子就不该发积分请求
    expect(getParentPointsMock).not.toHaveBeenCalled();
  });

  it('切换孩子后以新的 studentId 重新拉取概览', async () => {
    renderPage();

    expect(await screen.findByText('铸铁')).toBeInTheDocument();
    expect(getParentPointsMock).toHaveBeenLastCalledWith(1);

    switchStudent(2);

    await waitFor(() => expect(getParentPointsMock).toHaveBeenLastCalledWith(2));
    expect(getParentPointsMock).toHaveBeenCalledTimes(2);
  });

  it('切换孩子时立即退回骨架，不拿上一个孩子的分数顶替', async () => {
    renderPage();

    expect(await screen.findByText('铸铁')).toBeInTheDocument();

    getParentPointsMock.mockReturnValue(new Promise<MyPoints>(() => {}));
    switchStudent(2);

    expect(screen.queryByText('铸铁')).not.toBeInTheDocument();
    expect(screen.getByTestId('points-overview-skeleton')).toBeInTheDocument();
  });

  it('切换孩子时面板按 studentId 重挂载（丢弃草稿的机制）', async () => {
    renderPage();

    const before = await screen.findByTestId('points-panel-rules');
    expect(before).toHaveAttribute('data-student-id', '1');

    switchStudent(2);

    await waitFor(() =>
      expect(screen.getByTestId('points-panel-rules')).toHaveAttribute('data-student-id', '2'),
    );
    expect(screen.getByTestId('points-panel-rules')).not.toBe(before);
  });

  it('上一个孩子的迟到响应不会盖回当前孩子（并发守卫）', async () => {
    const slow = deferred<MyPoints>();
    const OTHER: MyPoints = {
      ...POINTS,
      balance: 999,
      level: { code: 'baiyin', name: '白银', index: 3, threshold: 2000 },
    };
    getParentPointsMock.mockReset();
    getParentPointsMock.mockImplementationOnce(() => slow.promise); // 孩子 1：挂起
    getParentPointsMock.mockResolvedValueOnce(OTHER); // 孩子 2：立刻返回

    renderPage();
    expect(getParentPointsMock).toHaveBeenLastCalledWith(1);

    switchStudent(2);
    expect(await screen.findByText('白银')).toBeInTheDocument();

    // 孩子 1 的响应现在才到 —— 必须被丢弃，不能盖成「铸铁」
    await act(async () => {
      slow.resolve(POINTS);
      await slow.promise;
    });

    expect(screen.getByText('白银')).toBeInTheDocument();
    expect(screen.queryByText('铸铁')).not.toBeInTheDocument();
    expect(screen.getByText('999 分')).toBeInTheDocument();
  });

  it('前一个孩子的失败态不带到下一个孩子（新孩子加载中 → 骨架，不是错误条）', async () => {
    getParentPointsMock.mockRejectedValueOnce(new Error('boom'));

    renderPage();
    expect(await screen.findByTestId('points-overview-error')).toBeInTheDocument();

    getParentPointsMock.mockReturnValue(new Promise<MyPoints>(() => {}));
    switchStudent(2);

    expect(screen.queryByTestId('points-overview-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('points-overview-skeleton')).toBeInTheDocument();
  });
});

describe('ParentPointsPage：未保存草稿保护（Task 6 脏状态注册通道）', () => {
  /** 在「奖励清单」Tab 里改一笔，制造未保存草稿。 */
  async function makeDraft() {
    const first = await screen.findByTestId('reward-row-11');
    fireEvent.change(within(first).getByLabelText('所需积分'), { target: { value: '300' } });
    return first;
  }

  it('面板脏时 Tab 标题打「未保存」小圆点', async () => {
    renderPage('/parent/rewards?tab=catalog');
    await screen.findByTestId('reward-row-11');

    expect(screen.queryByTestId('points-tab-catalog-dirty')).not.toBeInTheDocument();

    await makeDraft();

    expect(screen.getByTestId('points-tab-catalog-dirty')).toBeInTheDocument();
  });

  it('面板不脏时切 Tab 不弹窗（日常操作不能被骚扰）', async () => {
    renderPage('/parent/rewards?tab=catalog');
    await screen.findByTestId('reward-row-11');

    fireEvent.click(screen.getByRole('tab', { name: '积分规则' }));

    expect(screen.getByTestId('points-panel-rules')).toBeInTheDocument();
    expect(screen.queryByText(/有未保存的修改/)).not.toBeInTheDocument();
  });

  it('未保存就切 Tab → 先弹确认；取消 → 留在原 Tab 且草稿还在', async () => {
    renderPage('/parent/rewards?tab=catalog');
    await makeDraft();

    fireEvent.click(screen.getByRole('tab', { name: '积分规则' }));

    expect(await screen.findByText(/有未保存的修改，确定离开吗/)).toBeInTheDocument();
    // 还没真的切走：面板仍是奖励清单
    expect(screen.getByTestId('points-panel-catalog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.getByTestId('points-panel-catalog')).toBeInTheDocument();
    expect(screen.queryByTestId('points-panel-rules')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '奖励清单' })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByTestId('reward-row-11')).getByLabelText('所需积分')).toHaveValue(300);
  });

  it('未保存就切 Tab → 确认离开后真的切走', async () => {
    renderPage('/parent/rewards?tab=catalog');
    await makeDraft();

    fireEvent.click(screen.getByRole('tab', { name: '积分规则' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认离开' }));

    expect(await screen.findByTestId('points-panel-rules')).toBeInTheDocument();
    expect(screen.queryByTestId('points-panel-catalog')).not.toBeInTheDocument();
  });

  it('未保存时切孩子 → 先弹确认；取消 → 回到原孩子且草稿还在', async () => {
    renderPage('/parent/rewards?tab=catalog');
    await makeDraft();

    switchStudent(2);

    expect(await screen.findByText(/有未保存的修改，确定离开吗/)).toBeInTheDocument();
    // 弹窗没被回答前不许换人：面板仍是孩子 1 的
    expect(screen.getByTestId('points-panel-catalog')).toHaveAttribute('data-student-id', '1');

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => expect(useParentStudentStore.getState().studentId).toBe(1));
    expect(screen.getByTestId('points-panel-catalog')).toHaveAttribute('data-student-id', '1');
    expect(within(screen.getByTestId('reward-row-11')).getByLabelText('所需积分')).toHaveValue(300);
    // 没为「孩子 2」发过清单请求
    expect(getParentRewardCatalogMock.mock.calls.map((call) => call[0])).toEqual([1]);
  });

  it('未保存时切孩子 → 确认后换人，且以新 id 重拉清单（草稿丢弃）', async () => {
    renderPage('/parent/rewards?tab=catalog');
    await makeDraft();

    switchStudent(2);
    fireEvent.click(await screen.findByRole('button', { name: '确认离开' }));

    await waitFor(() => expect(getParentRewardCatalogMock).toHaveBeenLastCalledWith(2));
    await waitFor(() =>
      expect(screen.getByTestId('points-panel-catalog')).toHaveAttribute('data-student-id', '2'),
    );
    // 新孩子的面板是新挂载的：草稿没了，回到服务端快照
    const first = await screen.findByTestId('reward-row-11');
    expect(within(first).getByLabelText('所需积分')).toHaveValue(200);
  });

  it('面板干净时切孩子直接换人（不弹窗）', async () => {
    renderPage('/parent/rewards?tab=catalog');
    await screen.findByTestId('reward-row-11');

    switchStudent(2);

    await waitFor(() => expect(getParentRewardCatalogMock).toHaveBeenLastCalledWith(2));
    expect(screen.queryByText(/有未保存的修改/)).not.toBeInTheDocument();
    expect(screen.getByTestId('points-panel-catalog')).toHaveAttribute('data-student-id', '2');
  });
});
