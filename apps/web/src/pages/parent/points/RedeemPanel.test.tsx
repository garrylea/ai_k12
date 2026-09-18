import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import RedeemPanel from './RedeemPanel';
import { previewCashAmount } from './previewCash';
import { toast } from '@/components/base';
import {
  ApiError,
  getLevels,
  getParentPoints,
  getParentPointsSettings,
  getParentRewardCatalog,
  redeemParentPoints,
  type MyPoints,
  type PointLevel,
  type PointsSettings,
  type RedeemResult,
  type RewardCatalogView,
} from '@/services/api';

/**
 * 家长端「兑换」表单（计划三 §2.6(b) / §2.8 / §3 Task 7）。
 *
 * 硬要求（每条都对应一个真实会坏的行为）：
 * 1. **金额预览与后端同口径取整**：`Math.round(points * 100 / perYuan) / 100`。
 *    写成 `points / perYuan` 再 `toFixed` 在非默认汇率下会差 1 分。取整口径单独测纯函数，
 *    页面测试只断言「预览区渲染了 `previewCashAmount` 的返回值」。
 * 2. **确认弹窗必须写明不可撤销**（spec §7.3 已知限制）；未确认绝不发请求。
 * 3. 余额不足 → 提交 disabled + inline，**本地判断只是 UX，服务端仍会兜底 3001**。
 * 4. 错误码分流（§2.8 唯一映射表）：`3001`/`3002` inline **不 toast**；`3003` toast +
 *    重拉清单；`3004` 表单整块置灰 + inline。
 * 5. 换奖励只列已上架（`isActive: true`）；门槛不满足的项 disabled 且说明原因。
 * 6. 段位名只能来自 `getLevels()`（单一真源在后端）。
 */

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

/** 孩子是「青铜」（index 2，totalEarned 1500），所以「白银」门槛的奖励不满足。 */
const POINTS: MyPoints = {
  balance: 1000,
  totalEarned: 1500,
  todayEarned: 10,
  level: LEVELS[2],
  nextLevel: LEVELS[3],
  pointsToNextLevel: 500,
  progressPercent: 38,
};

const SETTINGS: PointsSettings = { pointsPerYuan: 20, rewardRedemptionEnabled: true };

const CATALOG: RewardCatalogView[] = [
  // 段位不够（白银 > 青铜）但分够：disabled 且说明「需达到白银」
  {
    id: 11,
    name: '周末看电影',
    description: null,
    pointsCost: 200,
    minLevelCode: 'baiyin',
    isActive: true,
    sortOrder: 0,
  },
  // 可兑
  {
    id: 12,
    name: '多玩半小时游戏',
    description: null,
    pointsCost: 50,
    minLevelCode: null,
    isActive: true,
    sortOrder: 10,
  },
  // 已下架：不能出现在选项里
  {
    id: 13,
    name: '买一本漫画',
    description: null,
    pointsCost: 80,
    minLevelCode: null,
    isActive: false,
    sortOrder: 20,
  },
  // 分不够：gap = 5000 - 1000 = 4000
  {
    id: 14,
    name: '去游乐园',
    description: null,
    pointsCost: 5000,
    minLevelCode: null,
    isActive: true,
    sortOrder: 30,
  },
];

function successResult(overrides: Partial<RedeemResult['redemption']> = {}): RedeemResult {
  return {
    redemption: {
      id: 5,
      type: 'cash',
      pointsSpent: 100,
      cashAmount: 5,
      rewardCatalogId: null,
      rewardName: null,
      status: 'pending',
      note: null,
      ledgerId: 9,
      createdAt: '2026-09-18T00:00:00.000Z',
      fulfilledAt: null,
      ...overrides,
    },
    balance: 900,
    totalEarned: 1500,
    level: LEVELS[2],
  };
}

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getParentPoints: vi.fn(),
    getParentPointsSettings: vi.fn(),
    getParentRewardCatalog: vi.fn(),
    getLevels: vi.fn(),
    redeemParentPoints: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const getPointsMock = vi.mocked(getParentPoints);
const getSettingsMock = vi.mocked(getParentPointsSettings);
const getCatalogMock = vi.mocked(getParentRewardCatalog);
const getLevelsMock = vi.mocked(getLevels);
const redeemMock = vi.mocked(redeemParentPoints);
const toastMock = vi.mocked(toast);

/** 等表单就绪（四份数据都到了才渲染表单）。 */
async function ready() {
  await screen.findByTestId('redeem-form');
}

/** 输入积分数并点提交（到确认弹窗为止，不发请求）。 */
function fillCashAndSubmit(points: string) {
  fireEvent.change(screen.getByTestId('redeem-points-input'), { target: { value: points } });
  fireEvent.click(screen.getByTestId('redeem-submit'));
}

/** 等确认弹窗出现后点「确认兑换」。 */
async function confirmModal() {
  await screen.findByText(/兑换不可撤销/);
  fireEvent.click(screen.getByTestId('redeem-confirm'));
}

function pickRewardMode() {
  fireEvent.click(screen.getByRole('radio', { name: '换奖励' }));
}

beforeEach(() => {
  getPointsMock.mockReset();
  getSettingsMock.mockReset();
  getCatalogMock.mockReset();
  getLevelsMock.mockReset();
  redeemMock.mockReset();
  toastMock.mockReset();
  getPointsMock.mockResolvedValue(POINTS);
  getSettingsMock.mockResolvedValue(SETTINGS);
  getCatalogMock.mockResolvedValue(CATALOG);
  getLevelsMock.mockResolvedValue({ levels: LEVELS });
  redeemMock.mockResolvedValue(successResult());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * 取整口径**单独测纯函数**（计划 §3 Task 7 明确要求）：
 * 直接断言它等于后端 `redemption.service` 的同一条公式。
 * 页面测试只负责断言「预览区渲染了这个函数的返回值」，不侧面猜实现。
 */
describe('previewCashAmount：与后端同口径取整', () => {
  it('对一组输入等于 Math.round(points * 100 / perYuan) / 100', () => {
    const cases: Array<[number, number]> = [
      [100, 20],
      [50, 20],
      [1, 1],
      [9999, 9999],
      [1234, 7],
      [100, 3],
      [201, 200],
      [7, 9999],
    ];
    for (const [points, perYuan] of cases) {
      expect(previewCashAmount(points, perYuan)).toBe(Math.round((points * 100) / perYuan) / 100);
    }
  });

  it('默认汇率 20：100 积分 = 5 元', () => {
    expect(previewCashAmount(100, 20)).toBe(5);
  });

  /**
   * 浮点陷阱的显式钉子（后端注释同例）：`Math.round((201/200)*100)/100` 因二进制浮点
   * 误差得 1.00，而整数运算再除应得 1.01。这条是**直接断言函数输出**，不是侧面测实现。
   */
  it('201 积分 / 200 分每元 = 1.01 元（不是 1.00）', () => {
    expect(previewCashAmount(201, 200)).toBe(1.01);
  });
});

describe('RedeemPanel：换钱', () => {
  it('输入 100、pointsPerYuan=20 → 预览区渲染 previewCashAmount 的返回值 ¥5.00', async () => {
    render(<RedeemPanel studentId={1} />);
    await ready();

    fireEvent.change(screen.getByTestId('redeem-points-input'), { target: { value: '100' } });

    expect(screen.getByTestId('redeem-cash-preview')).toHaveTextContent(
      `¥${previewCashAmount(100, 20).toFixed(2)}`,
    );
    expect(screen.getByTestId('redeem-cash-preview')).toHaveTextContent('¥5.00');
    // 扣除与兑换后余额
    expect(screen.getByTestId('redeem-cash-summary')).toHaveTextContent('将扣除 100 积分');
    expect(screen.getByTestId('redeem-cash-summary')).toHaveTextContent('兑换后余额 900 分');
  });

  it('余额不足 → 提交 disabled + inline 提示；点击不发请求', async () => {
    render(<RedeemPanel studentId={1} />);
    await ready();

    fireEvent.change(screen.getByTestId('redeem-points-input'), { target: { value: '2000' } });

    const submit = screen.getByTestId('redeem-submit');
    expect(submit).toBeDisabled();
    expect(screen.getByTestId('redeem-inline')).toHaveTextContent('可用积分不足，当前 1000 分');

    fireEvent.click(submit);
    expect(redeemMock).not.toHaveBeenCalled();
  });

  it('确认弹窗：写明不可撤销；未确认不发请求，确认后 body 恰为 {type:cash,points:100}', async () => {
    render(<RedeemPanel studentId={1} />);
    await ready();

    fillCashAndSubmit('100');

    expect(await screen.findByText(/兑换不可撤销/)).toBeInTheDocument();
    expect(redeemMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('redeem-confirm'));

    await waitFor(() =>
      expect(redeemMock).toHaveBeenCalledWith(1, { type: 'cash', points: 100 }),
    );
    // body 恰好这两个字段
    expect(Object.keys(redeemMock.mock.calls[0][1]).sort()).toEqual(['points', 'type']);
  });

  it('兑换成功 → toast 金额 + onPointsChanged + 重拉清单', async () => {
    const onPointsChanged = vi.fn();
    render(<RedeemPanel studentId={1} onPointsChanged={onPointsChanged} />);
    await ready();

    fillCashAndSubmit('100');
    await confirmModal();

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('success', '已为孩子兑换 ¥5.00'));
    expect(onPointsChanged).toHaveBeenCalledTimes(1);
    // 余额/清单刷新（points + catalog 重拉）
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalledTimes(2));
  });
});

describe('RedeemPanel：换奖励', () => {
  it('只列已上架：isActive:false 的奖励不出现', async () => {
    render(<RedeemPanel studentId={1} />);
    await ready();
    pickRewardMode();

    expect(screen.getByTestId('reward-option-11')).toBeInTheDocument();
    expect(screen.getByTestId('reward-option-12')).toBeInTheDocument();
    expect(screen.getByTestId('reward-option-14')).toBeInTheDocument();
    expect(screen.queryByTestId('reward-option-13')).not.toBeInTheDocument();
  });

  it('门槛不满足的项 disabled 且说明「需达到 XX」；分不够的项说明 gap', async () => {
    render(<RedeemPanel studentId={1} />);
    await ready();
    pickRewardMode();

    const levelShort = screen.getByTestId('reward-option-11');
    expect(levelShort).toBeDisabled();
    expect(within(levelShort).getByText(/需达到/)).toHaveTextContent('白银');

    const pointsShort = screen.getByTestId('reward-option-14');
    expect(pointsShort).toBeDisabled();
    expect(within(pointsShort).getByText('还差 4000 分')).toBeInTheDocument();

    // 可兑项 enabled
    expect(screen.getByTestId('reward-option-12')).toBeEnabled();
  });

  it('选中可兑奖励 → 确认后 body 为 {type:reward,catalogId}，toast 奖励名', async () => {
    render(<RedeemPanel studentId={1} />);
    await ready();
    pickRewardMode();

    fireEvent.click(screen.getByTestId('reward-option-12'));
    expect(screen.getByTestId('reward-option-12')).toHaveAttribute('aria-checked', 'true');

    redeemMock.mockResolvedValueOnce(
      successResult({
        type: 'reward',
        pointsSpent: 50,
        cashAmount: null,
        rewardCatalogId: 12,
        rewardName: '多玩半小时游戏',
      }),
    );

    fireEvent.click(screen.getByTestId('redeem-submit'));
    await confirmModal();

    await waitFor(() =>
      expect(redeemMock).toHaveBeenCalledWith(1, { type: 'reward', catalogId: 12 }),
    );
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('success', '已兑换「多玩半小时游戏」'));
  });

  it('disabled 的奖励点不动，不会变成选中项', async () => {
    render(<RedeemPanel studentId={1} />);
    await ready();
    pickRewardMode();

    fireEvent.click(screen.getByTestId('reward-option-11'));
    expect(screen.getByTestId('reward-option-11')).toHaveAttribute('aria-checked', 'false');
    // 没有可提交的选中项
    expect(screen.getByTestId('redeem-submit')).toBeDisabled();
  });
});

describe('RedeemPanel：错误码分流（§2.8）', () => {
  it('3001 → inline 且没有 toast', async () => {
    render(<RedeemPanel studentId={1} />);
    await ready();

    // 本地看 50 <= 1000 是够的，服务端并发下 reject 3001 —— 必须按错误处理，不乐观放行
    redeemMock.mockRejectedValueOnce(new ApiError(3001, '积分余额不足'));
    fillCashAndSubmit('50');
    await confirmModal();

    await waitFor(() =>
      expect(screen.getByTestId('redeem-inline')).toHaveTextContent('可用积分不足'),
    );
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('3002 → inline 段位门槛说明，不 toast', async () => {
    // 模拟数据漂移：本地看孩子已到白银、该项可兑，服务端仍拒 3002
    getPointsMock.mockResolvedValue({
      ...POINTS,
      level: LEVELS[3],
      totalEarned: 2500,
    });
    render(<RedeemPanel studentId={1} />);
    await ready();
    pickRewardMode();

    fireEvent.click(screen.getByTestId('reward-option-11'));
    redeemMock.mockRejectedValueOnce(new ApiError(3002, '未达该奖励的段位门槛'));
    fireEvent.click(screen.getByTestId('redeem-submit'));
    await confirmModal();

    await waitFor(() =>
      expect(screen.getByTestId('redeem-inline')).toHaveTextContent('该奖励需达到「白银」才可兑换'),
    );
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('3004 → 表单整块置灰 + inline 文案，不 toast', async () => {
    render(<RedeemPanel studentId={1} />);
    await ready();

    redeemMock.mockRejectedValueOnce(new ApiError(3004, '兑换已关闭'));
    fillCashAndSubmit('50');
    await confirmModal();

    await waitFor(() => expect(screen.getByTestId('redeem-form')).toHaveAttribute('data-disabled', 'true'));
    expect(screen.getByTestId('redeem-inline')).toHaveTextContent('兑换已关闭，可在上方设置中开启');
    expect(screen.getByTestId('redeem-submit')).toBeDisabled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('3004 之后在上方设置里重新打开开关（settingsVersion 变化）→ 解除置灰', async () => {
    const { rerender } = render(<RedeemPanel studentId={1} settingsVersion={0} />);
    await ready();

    redeemMock.mockRejectedValueOnce(new ApiError(3004, '兑换已关闭'));
    fillCashAndSubmit('50');
    await confirmModal();
    await waitFor(() =>
      expect(screen.getByTestId('redeem-form')).toHaveAttribute('data-disabled', 'true'),
    );

    // 设置面板保存成功 → 版本 +1，服务端读回来开关是开的（同样是上面 mock 的开值）
    rerender(<RedeemPanel studentId={1} settingsVersion={1} />);

    await waitFor(() =>
      expect(screen.getByTestId('redeem-form')).not.toHaveAttribute('data-disabled', 'true'),
    );
    expect(screen.getByTestId('redeem-submit')).toBeEnabled();
  });

  it('3003 → toast + 重拉奖励清单', async () => {
    render(<RedeemPanel studentId={1} />);
    await ready();
    pickRewardMode();

    fireEvent.click(screen.getByTestId('reward-option-12'));
    redeemMock.mockRejectedValueOnce(new ApiError(3003, '奖励已下架'));
    fireEvent.click(screen.getByTestId('redeem-submit'));
    await confirmModal();

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '奖励已下架'));
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalledTimes(2));
  });

  it('其它错误 → toast 服务端文案', async () => {
    render(<RedeemPanel studentId={1} />);
    await ready();

    redeemMock.mockRejectedValueOnce(new ApiError(5000, '服务端开小差了'));
    fillCashAndSubmit('50');
    await confirmModal();

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '服务端开小差了'));
  });
});

describe('RedeemPanel：兑换设置耦合（开关关闭 → 表单置灰）', () => {
  it('rewardRedemptionEnabled:false → 表单置灰 + inline「兑换已关闭，打开开关后可兑换」', async () => {
    getSettingsMock.mockResolvedValue({ pointsPerYuan: 20, rewardRedemptionEnabled: false });

    render(<RedeemPanel studentId={1} />);
    await ready();

    expect(screen.getByTestId('redeem-form')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('redeem-inline')).toHaveTextContent('兑换已关闭，打开开关后可兑换');
    expect(screen.getByTestId('redeem-submit')).toBeDisabled();
  });

  it('settingsVersion 变化 → 重新读取设置并跟随开关（页面在上方面板保存后通知）', async () => {
    const { rerender } = render(<RedeemPanel studentId={1} settingsVersion={0} />);
    await ready();
    expect(screen.getByTestId('redeem-form')).not.toHaveAttribute('data-disabled', 'true');

    getSettingsMock.mockResolvedValue({ pointsPerYuan: 20, rewardRedemptionEnabled: false });
    rerender(<RedeemPanel studentId={1} settingsVersion={1} />);

    await waitFor(() =>
      expect(screen.getByTestId('redeem-form')).toHaveAttribute('data-disabled', 'true'),
    );
    expect(getSettingsMock).toHaveBeenCalledTimes(2);
  });
});
