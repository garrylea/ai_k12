import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PointRulesPanel from './PointRulesPanel';
import { toast } from '@/components/base';
import {
  ApiError,
  getParentPointRules,
  saveParentPointRules,
  type MyPointRules,
} from '@/services/api';

/**
 * 家长端「积分规则」配置表（计划三 §2.4 / §3 Task 5）。
 *
 * 契约要点（每条都对应一个真实会坏的行为）：
 * 1. 渲染自 `GET /parent/students/:id/points/rules`，按 taskCode 分组；
 * 2. **已下架档位（isActive:false）必须照常渲染 + 开关可切回启用**——后端有意
 *    不过滤 is_active，只渲染 active 的行等于家长永远无法重新启用（§1.1#1）；
 * 3. 空 `tiers` 的任务显示「该任务暂无档位」，**不许** `tiers[0]` 默认取值（会崩）；
 * 4. 草稿未改动时保存 disabled，改动后 enabled；
 * 5. `dailyLimit` 空 = `null`（不限是一等公民），填 `0` 会让该档位永久不发分
 *    → 行内报错 + 保存禁用 + **不发请求**（§1.1#4）；
 * 6. 分值下调要先二次确认，未确认前**不许**发请求；
 * 7. 后端 3005（档位不存在）→ toast + 重拉 rules，避免家长拿着过期快照反复失败。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getParentPointRules: vi.fn(), saveParentPointRules: vi.fn() };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const getRulesMock = vi.mocked(getParentPointRules);
const saveRulesMock = vi.mocked(saveParentPointRules);
const toastMock = vi.mocked(toast);

/** 数学专项两档；英语背单词两档，其中「10 词」已下架。 */
const RULES: MyPointRules = {
  tasks: [
    {
      taskCode: 'math_targeted',
      taskName: '数学专项',
      tiers: [
        {
          tierKey: '1',
          tierLabel: '1 题',
          points: 3,
          dailyLimit: null,
          isActive: true,
          completedToday: 2,
          remainingToday: null,
        },
        {
          tierKey: '3',
          tierLabel: '3 题',
          points: 8,
          dailyLimit: 5,
          isActive: true,
          completedToday: 1,
          remainingToday: 4,
        },
      ],
    },
    {
      taskCode: 'english_words',
      taskName: '英语背单词',
      tiers: [
        {
          tierKey: '5',
          tierLabel: '5 词',
          points: 2,
          dailyLimit: null,
          isActive: true,
          completedToday: 0,
          remainingToday: null,
        },
        {
          tierKey: '10',
          tierLabel: '10 词',
          points: 5,
          dailyLimit: 3,
          isActive: false,
          completedToday: 0,
          remainingToday: 3,
        },
      ],
    },
  ],
};

function renderPanel(studentId = 1) {
  return render(<PointRulesPanel studentId={studentId} />);
}

function card(taskCode: string) {
  return screen.getByTestId(`point-rules-card-${taskCode}`);
}

beforeEach(() => {
  getRulesMock.mockReset();
  saveRulesMock.mockReset();
  toastMock.mockReset();
  getRulesMock.mockResolvedValue(RULES);
  saveRulesMock.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PointRulesPanel：渲染', () => {
  it('两个任务各两个档位，tierLabel、分值、taskCode 都渲染出来', async () => {
    renderPanel();

    expect(await screen.findByTestId('point-rules-card-math_targeted')).toBeInTheDocument();
    expect(getRulesMock).toHaveBeenCalledWith(1);

    const math = card('math_targeted');
    expect(within(math).getByText('数学专项')).toBeInTheDocument();
    // taskCode 小字便于对账
    expect(within(math).getByText('math_targeted')).toBeInTheDocument();
    expect(within(math).getByText('1 题')).toBeInTheDocument();
    expect(within(math).getByText('3 题')).toBeInTheDocument();
    expect(within(math).getByTestId('points-input-math_targeted-1')).toHaveValue(3);
    expect(within(math).getByTestId('points-input-math_targeted-3')).toHaveValue(8);

    const english = card('english_words');
    expect(within(english).getByText('english_words')).toBeInTheDocument();
    expect(within(english).getByText('5 词')).toBeInTheDocument();
    expect(within(english).getByText('10 词')).toBeInTheDocument();
    expect(within(english).getByTestId('points-input-english_words-5')).toHaveValue(2);
    expect(within(english).getByTestId('points-input-english_words-10')).toHaveValue(5);
  });

  it('「每日上限」为 null 时输入框为空且 placeholder 是「不限」，今日进度写明不限', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    const limit = within(math).getByTestId('limit-input-math_targeted-1');

    expect(limit).toHaveValue(null);
    expect(limit).toHaveAttribute('placeholder', '不限');
    expect(within(math).getByText('今日已发 2 次（不限）')).toBeInTheDocument();
    // 有上限的档位显示 N / M
    expect(within(math).getByText('今日已发 1 / 5 次')).toBeInTheDocument();
  });

  it('已下架档位照常渲染（有「已下架」标识），开关可切回启用', async () => {
    renderPanel();

    const english = await screen.findByTestId('point-rules-card-english_words');
    const row = within(english).getByTestId('tier-row-english_words-10');

    // 下架行存在且带标识（不是被过滤掉）
    expect(row).toBeInTheDocument();
    expect(within(row).getByText('已下架')).toBeInTheDocument();

    const toggle = within(row).getByTestId('tier-switch-english_words-10');
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(within(row).queryByText('已下架')).not.toBeInTheDocument();
    // 切开关只是草稿，不该发请求
    expect(saveRulesMock).not.toHaveBeenCalled();
  });

  it('某个任务 tiers 为空 → 显示「该任务暂无档位」，不崩也不给默认档位', async () => {
    getRulesMock.mockResolvedValue({
      tasks: [{ taskCode: 'chinese_meaning', taskName: '古诗含义', tiers: [] }],
    });

    renderPanel();

    const cardEl = await screen.findByTestId('point-rules-card-chinese_meaning');
    expect(within(cardEl).getByText('该任务暂无档位')).toBeInTheDocument();
    // 没有档位 = 没有可改的东西 → 保存禁用
    expect(within(cardEl).getByTestId('save-task-chinese_meaning')).toBeDisabled();
  });

  it('tasks 为空数组 → 空态「暂无积分任务配置」', async () => {
    getRulesMock.mockResolvedValue({ tasks: [] });

    renderPanel();

    expect(await screen.findByTestId('point-rules-empty')).toBeInTheDocument();
    expect(screen.getByText('暂无积分任务配置')).toBeInTheDocument();
  });

  it('加载中给骨架；加载失败给可重试的错误态', async () => {
    getRulesMock.mockReturnValue(new Promise<MyPointRules>(() => {}));

    renderPanel();

    expect(screen.getByTestId('point-rules-skeleton')).toBeInTheDocument();
  });

  it('加载失败 → 错误态 + 「重试」重新拉取', async () => {
    getRulesMock.mockRejectedValueOnce(new Error('boom'));

    renderPanel();

    const errorBox = await screen.findByTestId('point-rules-error');
    getRulesMock.mockResolvedValueOnce(RULES);
    fireEvent.click(within(errorBox).getByRole('button', { name: '重试' }));

    expect(await screen.findByTestId('point-rules-card-math_targeted')).toBeInTheDocument();
    expect(getRulesMock).toHaveBeenCalledTimes(2);
  });
});

describe('PointRulesPanel：草稿与校验', () => {
  it('未改动时「保存」disabled；改了分值后 enabled', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    const save = within(math).getByTestId('save-task-math_targeted');
    expect(save).toBeDisabled();

    fireEvent.change(within(math).getByTestId('points-input-math_targeted-3'), {
      target: { value: '9' },
    });

    expect(save).toBeEnabled();
  });

  it('「每日上限」清空 = 不限：提交 null，且整卡档位都带齐三字段', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    fireEvent.change(within(math).getByTestId('limit-input-math_targeted-3'), {
      target: { value: '' },
    });
    fireEvent.click(within(math).getByTestId('save-task-math_targeted'));

    await waitFor(() => expect(saveRulesMock).toHaveBeenCalledTimes(1));
    expect(saveRulesMock).toHaveBeenCalledWith(1, [
      {
        taskCode: 'math_targeted',
        tierKey: '1',
        points: 3,
        dailyLimit: null,
        isActive: true,
      },
      {
        taskCode: 'math_targeted',
        tierKey: '3',
        points: 8,
        dailyLimit: null,
        isActive: true,
      },
    ]);
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('success', '已保存「数学专项」的分值'),
    );
    // 保存成功后重拉，避免并发漂移
    await waitFor(() => expect(getRulesMock).toHaveBeenCalledTimes(2));
  });

  it('「每日上限」填 0 非法：行内报错 + 保存 disabled + 不发请求', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    fireEvent.change(within(math).getByTestId('limit-input-math_targeted-3'), {
      target: { value: '0' },
    });

    const row = within(math).getByTestId('tier-row-math_targeted-3');
    expect(within(row).getByText('不限请留空；填 0 会让该档位不再发分')).toBeInTheDocument();
    expect(within(math).getByTestId('save-task-math_targeted')).toBeDisabled();

    fireEvent.click(within(math).getByTestId('save-task-math_targeted'));
    expect(saveRulesMock).not.toHaveBeenCalled();
  });

  it('分值超出 0–9999 非法：行内报错 + 保存 disabled', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    fireEvent.change(within(math).getByTestId('points-input-math_targeted-1'), {
      target: { value: '10000' },
    });

    const row = within(math).getByTestId('tier-row-math_targeted-1');
    expect(within(row).getByText('分值请填 0–9999 的整数')).toBeInTheDocument();
    expect(within(math).getByTestId('save-task-math_targeted')).toBeDisabled();
  });
});

describe('PointRulesPanel：保存与二次确认', () => {
  it('分值下调先弹确认；未确认前不发请求，确认后才发', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    fireEvent.change(within(math).getByTestId('points-input-math_targeted-3'), {
      target: { value: '2' },
    });
    fireEvent.click(within(math).getByTestId('save-task-math_targeted'));

    expect(await screen.findByText(/孩子之后完成该任务只能拿新分值，历史流水不变/)).toBeInTheDocument();
    expect(saveRulesMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认保存' }));

    await waitFor(() => expect(saveRulesMock).toHaveBeenCalledTimes(1));
    expect(saveRulesMock.mock.calls[0][1]).toContainEqual({
      taskCode: 'math_targeted',
      tierKey: '3',
      points: 2,
      dailyLimit: 5,
      isActive: true,
    });
  });

  it('取消二次确认 → 不发请求', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    fireEvent.change(within(math).getByTestId('points-input-math_targeted-3'), {
      target: { value: '2' },
    });
    fireEvent.click(within(math).getByTestId('save-task-math_targeted'));

    await screen.findByText(/历史流水不变/);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(saveRulesMock).not.toHaveBeenCalled();
  });

  it('档位由启用改为停用 → 弹确认，文案写明不再发分', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    fireEvent.click(within(math).getByTestId('tier-switch-math_targeted-3'));
    fireEvent.click(within(math).getByTestId('save-task-math_targeted'));

    expect(
      await screen.findByText(/该档位不会再出现在孩子的可选档位里，也不会再发分/),
    ).toBeInTheDocument();
    expect(saveRulesMock).not.toHaveBeenCalled();
  });

  it('分值上调不弹确认，直接保存', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    fireEvent.change(within(math).getByTestId('points-input-math_targeted-3'), {
      target: { value: '10' },
    });
    fireEvent.click(within(math).getByTestId('save-task-math_targeted'));

    await waitFor(() => expect(saveRulesMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/历史流水不变/)).not.toBeInTheDocument();
  });

  it('后端返回 3005 → toast 报错 + 重拉 rules', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    fireEvent.change(within(math).getByTestId('points-input-math_targeted-3'), {
      target: { value: '10' },
    });
    saveRulesMock.mockRejectedValueOnce(new ApiError(3005, '档位不存在'));
    fireEvent.click(within(math).getByTestId('save-task-math_targeted'));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('error', '档位已变化，请确认后重新保存'),
    );
    await waitFor(() => expect(getRulesMock).toHaveBeenCalledTimes(2));
  });

  it('后端返回 1001 → toast 回显服务端校验文案', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    fireEvent.change(within(math).getByTestId('points-input-math_targeted-3'), {
      target: { value: '10' },
    });
    saveRulesMock.mockRejectedValueOnce(new ApiError(1001, 'dailyLimit 非法'));
    fireEvent.click(within(math).getByTestId('save-task-math_targeted'));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('error', 'dailyLimit 非法'),
    );
  });
});

describe('PointRulesPanel：切孩子', () => {
  it('studentId 变化 → 以新 id 重拉并丢弃草稿', async () => {
    const { rerender } = renderPanel(1);

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    fireEvent.change(within(math).getByTestId('points-input-math_targeted-3'), {
      target: { value: '99' },
    });
    expect(within(math).getByTestId('save-task-math_targeted')).toBeEnabled();

    rerender(<PointRulesPanel studentId={2} />);

    await waitFor(() => expect(getRulesMock).toHaveBeenLastCalledWith(2));
    const refreshed = await screen.findByTestId('point-rules-card-math_targeted');
    // 草稿被丢弃：回到服务器快照（8），保存重新变 disabled
    expect(within(refreshed).getByTestId('points-input-math_targeted-3')).toHaveValue(8);
    expect(within(refreshed).getByTestId('save-task-math_targeted')).toBeDisabled();
  });
});
