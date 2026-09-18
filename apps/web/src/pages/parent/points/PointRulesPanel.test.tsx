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
 * 7. 后端 3005（档位不存在）→ toast + 重拉 rules，避免家长拿着过期快照反复失败；
 * 8. **重新启用**下架档位时，`isActive: true` 必须真的进 body（读服务端原值 = 静默
 *    no-op，家长永远救不回下架档位，§1.1#1）——这是本组件存在的理由，必须被钉住；
 * 9. `points` 边界：`0` 合法、`''` / `'-1'` 非法（不许把空串静默当 0）；
 * 10. 保存 A 卡只重挂 A 卡，B 卡未保存的草稿不能被连带清掉（只接受切 Tab/切孩子丢草稿）；
 * 11. **待重挂的卡是集合不是单槽**：A 的重拉窗口内又保存 B，两张卡都要结算，
 *     谁都不许永久 `saving=true`（曾用单槽 ref，A 会被 B 覆盖而永远转圈）；
 * 12. 重拉失败也必须解除 `saving`（不重挂载的那条路径），且保留旧表格、不波及别的卡；
 * 13. 重拉带来本卡没有 draft 的新档位时，保存要跳过它（不崩、不发假编辑）+ 内部告警。
 */

/** 手动控制时序的 promise（重拉窗口内再保存、重拉成功/失败都由用例说了算）。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 把某档位的 JSON 深拷贝后改字段，避免用例间共享对象被改。 */
function withTier(
  base: MyPointRules,
  taskCode: string,
  tierKey: string,
  patch: Partial<MyPointRules['tasks'][number]['tiers'][number]>,
): MyPointRules {
  return {
    tasks: base.tasks.map((task) =>
      task.taskCode === taskCode
        ? {
            ...task,
            tiers: task.tiers.map((tier) =>
              tier.tierKey === tierKey ? { ...tier, ...patch } : tier,
            ),
          }
        : task,
    ),
  };
}

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

  it('data-student-id 落在面板的**根元素**上（骨架/错误/空态都在，与其它四个面板同款）', async () => {
    // 骨架态：根就是骨架 div（此时断言在 mock 兑现前同步做）
    getRulesMock.mockReturnValue(new Promise<MyPointRules>(() => {}));
    const skeletonRender = renderPanel(7);
    expect(skeletonRender.container.firstChild).toHaveAttribute('data-student-id', '7');
    skeletonRender.unmount();

    // 错误态：根是错误 Card
    getRulesMock.mockRejectedValueOnce(new Error('boom'));
    const errorRender = renderPanel(7);
    const errorBox = await screen.findByTestId('point-rules-error');
    expect(errorRender.container.firstChild).toBe(errorBox);
    expect(errorBox).toHaveAttribute('data-student-id', '7');
    errorRender.unmount();

    // 空态：根是空态 Card
    getRulesMock.mockResolvedValue({ tasks: [] });
    const emptyRender = renderPanel(7);
    const empty = await screen.findByTestId('point-rules-empty');
    expect(emptyRender.container.firstChild).toBe(empty);
    expect(empty).toHaveAttribute('data-student-id', '7');
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

  it('分值填 0 合法（区间下界就是 0）：无行内报错、可保存、body 里 points 为 0', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    const input = within(math).getByTestId('points-input-math_targeted-1');
    fireEvent.change(input, { target: { value: '0' } });
    // 先确认输入框真的持有了 '0'（不是被 number input 归一成空串，那样会假绿）
    expect(input).toHaveValue(0);

    expect(within(math).queryByText('分值请填 0–9999 的整数')).not.toBeInTheDocument();
    const save = within(math).getByTestId('save-task-math_targeted');
    expect(save).toBeEnabled();

    // 3 → 0 属于下调，先过二次确认再校验 body（0 必须原样发出，不能被吞成 null）
    fireEvent.click(save);
    fireEvent.click(await screen.findByRole('button', { name: '确认保存' }));

    await waitFor(() => expect(saveRulesMock).toHaveBeenCalledTimes(1));
    expect(saveRulesMock.mock.calls[0][1]).toContainEqual({
      taskCode: 'math_targeted',
      tierKey: '1',
      points: 0,
      dailyLimit: null,
      isActive: true,
    });
  });

  it('分值清空非法：行内报错 + 保存 disabled + 不发请求（不许把空串静默当 0 提交）', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    const input = within(math).getByTestId('points-input-math_targeted-1');
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue(null);

    const row = within(math).getByTestId('tier-row-math_targeted-1');
    expect(within(row).getByText('分值请填 0–9999 的整数')).toBeInTheDocument();
    const save = within(math).getByTestId('save-task-math_targeted');
    expect(save).toBeDisabled();

    fireEvent.click(save);
    expect(saveRulesMock).not.toHaveBeenCalled();
  });

  it('分值填负数非法：行内报错 + 保存 disabled + 不发请求', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    const input = within(math).getByTestId('points-input-math_targeted-1');
    fireEvent.change(input, { target: { value: '-1' } });
    // 负号没被 number input 吞掉，错误确实来自 `/^\d+$/` 守卫
    expect(input).toHaveValue(-1);

    const row = within(math).getByTestId('tier-row-math_targeted-1');
    expect(within(row).getByText('分值请填 0–9999 的整数')).toBeInTheDocument();
    const save = within(math).getByTestId('save-task-math_targeted');
    expect(save).toBeDisabled();

    fireEvent.click(save);
    expect(saveRulesMock).not.toHaveBeenCalled();
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

  it('已下架档位切回启用 → 保存 body 里该档位 isActive 为 true（「重新启用」不是 no-op）', async () => {
    renderPanel();

    const english = await screen.findByTestId('point-rules-card-english_words');
    // 「10 词」在 fixture 里是 isActive:false（下架）
    fireEvent.click(within(english).getByTestId('tier-switch-english_words-10'));
    fireEvent.click(within(english).getByTestId('save-task-english_words'));

    await waitFor(() => expect(saveRulesMock).toHaveBeenCalledTimes(1));
    const body = saveRulesMock.mock.calls[0][1];

    // 核心断言：草稿的 isActive 必须进 body。若实现改成读服务端原值（tier.isActive），
    // 这里会拿到 false —— 服务端静默 no-op，家长永远救不回下架档位（计划 §1.1#1）。
    expect(body).toContainEqual({
      taskCode: 'english_words',
      tierKey: '10',
      points: 5,
      dailyLimit: 3,
      isActive: true,
    });
    // 同卡另一档位原样带出（整卡三字段齐全）
    expect(body).toContainEqual({
      taskCode: 'english_words',
      tierKey: '5',
      points: 2,
      dailyLimit: null,
      isActive: true,
    });
    // 启用不是「停用」，不该弹二次确认
    expect(screen.queryByRole('button', { name: '确认保存' })).not.toBeInTheDocument();
  });

  it('保存某张卡后，另一张卡未保存的草稿仍在（重挂载只作用于被保存的那张卡）', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    const english = screen.getByTestId('point-rules-card-english_words');

    // B（英语）卡改一半，不保存
    fireEvent.change(within(english).getByTestId('points-input-english_words-5'), {
      target: { value: '7' },
    });

    // A（数学）卡上调分值并保存
    fireEvent.change(within(math).getByTestId('points-input-math_targeted-3'), {
      target: { value: '10' },
    });
    fireEvent.click(within(math).getByTestId('save-task-math_targeted'));

    await waitFor(() => expect(saveRulesMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getRulesMock).toHaveBeenCalledTimes(2));

    // A 卡重挂载 → 回到服务器快照（8），保存重新 disabled
    const refreshedMath = screen.getByTestId('point-rules-card-math_targeted');
    expect(within(refreshedMath).getByTestId('points-input-math_targeted-3')).toHaveValue(8);
    expect(within(refreshedMath).getByTestId('save-task-math_targeted')).toBeDisabled();

    // B 卡没被重挂载 → 草稿（7）还在，保存仍可点
    const refreshedEnglish = screen.getByTestId('point-rules-card-english_words');
    expect(within(refreshedEnglish).getByTestId('points-input-english_words-5')).toHaveValue(7);
    expect(within(refreshedEnglish).getByTestId('save-task-english_words')).toBeEnabled();
  });
});

describe('PointRulesPanel：并发保存与重拉', () => {
  /**
   * 时序一：**不重叠**。A 的重拉回来、A 卡结算完，再动 B。
   * 钉法：让服务端快照的值与用户输入**故意不同**（输入 10 快照 12），
   * 重挂不清草稿的话输入框仍是 10，断言 12 就同时钉住「重挂」+「draft 被清」。
   */
  it('依次保存 A、B（不重叠）→ 两张卡各自按新快照重挂，草稿都清', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    const afterMathSave = withTier(RULES, 'math_targeted', '3', { points: 12 });
    getRulesMock.mockResolvedValueOnce(afterMathSave);

    fireEvent.change(within(math).getByTestId('points-input-math_targeted-3'), {
      target: { value: '10' },
    });
    fireEvent.click(within(math).getByTestId('save-task-math_targeted'));

    await waitFor(() => expect(getRulesMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('point-rules-card-math_targeted')).getByTestId(
          'points-input-math_targeted-3',
        ),
      ).toHaveValue(12),
    );

    // A 已结算完，再保存 B（英语 5 词，输入 7 而快照 9）
    const afterEnglishSave = withTier(afterMathSave, 'english_words', '5', { points: 9 });
    getRulesMock.mockResolvedValueOnce(afterEnglishSave);

    fireEvent.change(
      within(screen.getByTestId('point-rules-card-english_words')).getByTestId(
        'points-input-english_words-5',
      ),
      { target: { value: '7' } },
    );
    fireEvent.click(
      within(screen.getByTestId('point-rules-card-english_words')).getByTestId(
        'save-task-english_words',
      ),
    );

    await waitFor(() => expect(getRulesMock).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('point-rules-card-english_words')).getByTestId(
          'points-input-english_words-5',
        ),
      ).toHaveValue(9),
    );

    const mathCard = screen.getByTestId('point-rules-card-math_targeted');
    const englishCard = screen.getByTestId('point-rules-card-english_words');
    const mathSave = within(mathCard).getByTestId('save-task-math_targeted');
    const englishSave = within(englishCard).getByTestId('save-task-english_words');
    // 两张卡都回到服务端快照：draft 清空 → 保存 disabled，且都不在转圈
    expect(mathSave).toBeDisabled();
    expect(englishSave).toBeDisabled();
    expect(mathSave.querySelector('.animate-spin')).toBeNull();
    expect(englishSave.querySelector('.animate-spin')).toBeNull();
  });

  /**
   * 时序二：**重叠**（本轮修的那个 bug）。A 的重拉还在路上就保存 B。
   * 单槽 ref 下 A 的那次 `.then` 读到的是 'B'，只有 B 被 bump → A 永久 saving=true。
   * 钉法：两次重拉都挂在 deferred 上，先 resolve 已被取消的 #1、再 resolve #2，
   * 最后断言**两张卡**都拿到新快照且都不转圈（A 是曾经会挂死的那个）。
   */
  it('A 的重拉窗口内又保存 B（重叠）→ 两张卡都结算，谁都不卡在 loading', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    const firstReload = deferred<MyPointRules>();
    const secondReload = deferred<MyPointRules>();
    getRulesMock
      .mockReturnValueOnce(firstReload.promise)
      .mockReturnValueOnce(secondReload.promise);

    // A 卡上调 8→10 并保存：重拉#1 发起后停在 deferred 上不返回
    fireEvent.change(within(math).getByTestId('points-input-math_targeted-3'), {
      target: { value: '10' },
    });
    fireEvent.click(within(math).getByTestId('save-task-math_targeted'));
    await waitFor(() => expect(getRulesMock).toHaveBeenCalledTimes(2));

    // A 的重拉还没回来 → 保存 B 卡（2→7），重拉#2 会把重拉#1 取消
    fireEvent.change(
      within(screen.getByTestId('point-rules-card-english_words')).getByTestId(
        'points-input-english_words-5',
      ),
      { target: { value: '7' } },
    );
    fireEvent.click(
      within(screen.getByTestId('point-rules-card-english_words')).getByTestId(
        'save-task-english_words',
      ),
    );
    await waitFor(() => expect(getRulesMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(saveRulesMock).toHaveBeenCalledTimes(2));

    // 两张卡都还在提交中：PUT 已完成但重拉未回 → saving 仍为 true（刻意的防重复提交）
    const mathSaveBefore = within(screen.getByTestId('point-rules-card-math_targeted')).getByTestId(
      'save-task-math_targeted',
    );
    const englishSaveBefore = within(
      screen.getByTestId('point-rules-card-english_words'),
    ).getByTestId('save-task-english_words');
    expect(mathSaveBefore.querySelector('.animate-spin')).not.toBeNull();
    expect(englishSaveBefore.querySelector('.animate-spin')).not.toBeNull();

    // 重拉#1 已被取消（结果必须被忽略），重拉#2 才算数；两份快照给同一批新值
    const snapshot = withTier(
      withTier(RULES, 'math_targeted', '3', { points: 12 }),
      'english_words',
      '5',
      { points: 9 },
    );
    firstReload.resolve(snapshot);
    secondReload.resolve(snapshot);

    await waitFor(() =>
      expect(
        within(screen.getByTestId('point-rules-card-math_targeted')).getByTestId(
          'points-input-math_targeted-3',
        ),
      ).toHaveValue(12),
    );

    const mathCard = screen.getByTestId('point-rules-card-math_targeted');
    const englishCard = screen.getByTestId('point-rules-card-english_words');
    // 两张卡都重挂到新快照（draft 清空 → 保存 disabled），都不再转圈
    expect(
      within(englishCard).getByTestId('points-input-english_words-5'),
    ).toHaveValue(9);
    const mathSave = within(mathCard).getByTestId('save-task-math_targeted');
    const englishSave = within(englishCard).getByTestId('save-task-english_words');
    expect(mathSave).toBeDisabled();
    expect(englishSave).toBeDisabled();
    expect(mathSave.querySelector('.animate-spin')).toBeNull();
    expect(englishSave.querySelector('.animate-spin')).toBeNull();
  });

  /**
   * 时序三：**重拉失败**。拿不到新快照 → 不能靠重挂载复位 saving，必须另有解除路径。
   * 钉法：重拉挂 deferred、先断言在途时仍转圈（防重复提交没被削弱），再 reject；
   * 失败后断言 ① 该卡 saving 已解（按钮回到可点、无 spinner）② 表格没被整块换成
   * 错误态 ③ 其它卡的未保存草稿不受影响。
   */
  it('保存后重拉失败 → 该卡 saving 复位（不转圈），表格与其它卡草稿都不受影响', async () => {
    renderPanel();

    const math = await screen.findByTestId('point-rules-card-math_targeted');
    const english = screen.getByTestId('point-rules-card-english_words');

    // B 卡有未保存草稿：重拉失败不许把它清掉、也不许把整张表换成错误态
    fireEvent.change(within(english).getByTestId('points-input-english_words-5'), {
      target: { value: '7' },
    });

    const failedReload = deferred<MyPointRules>();
    getRulesMock.mockReturnValueOnce(failedReload.promise);

    fireEvent.change(within(math).getByTestId('points-input-math_targeted-3'), {
      target: { value: '10' },
    });
    fireEvent.click(within(math).getByTestId('save-task-math_targeted'));
    await waitFor(() => expect(getRulesMock).toHaveBeenCalledTimes(2));

    // 在途：saving 还是 true（这是刻意保留的防重复提交窗口，不是卡死）
    const savePending = within(screen.getByTestId('point-rules-card-math_targeted')).getByTestId(
      'save-task-math_targeted',
    );
    expect(savePending).toBeDisabled();
    expect(savePending.querySelector('.animate-spin')).not.toBeNull();

    failedReload.reject(new Error('boom'));

    // 失败 → saving 复位：spinner 消失、草稿仍在所以按钮回到可点（能重试保存）
    await waitFor(() => {
      const save = within(screen.getByTestId('point-rules-card-math_targeted')).getByTestId(
        'save-task-math_targeted',
      );
      expect(save.querySelector('.animate-spin')).toBeNull();
      expect(save).toBeEnabled();
    });
    expect(within(screen.getByTestId('point-rules-card-math_targeted')).getByTestId(
      'points-input-math_targeted-3',
    )).toHaveValue(10);
    // 不整块变错误态；给出可感知的失败提示
    expect(screen.queryByTestId('point-rules-error')).not.toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith('error', '积分规则刷新失败，请稍后重试');
    // 其它卡不受影响：草稿还在 7
    expect(
      within(screen.getByTestId('point-rules-card-english_words')).getByTestId(
        'points-input-english_words-5',
      ),
    ).toHaveValue(7);
  });

  /**
   * 缺 draft 的降级路径（第 2 条）：A 卡保存后的重拉给**英语卡**带来一个新档位，
   * 但英语卡不会重挂载 → 它的 draft 里没有这个新档位（行也不渲染）。
   * 此时保存英语卡：不许抛 `Cannot read properties of undefined`，跳过该档位并告警。
   */
  it('重拉带来本卡没有 draft 的新档位 → 保存时跳过该档位（不崩、不发假编辑）+ 内部告警', async () => {
    renderPanel();

    const english = await screen.findByTestId('point-rules-card-english_words');
    // 英语卡先改一笔草稿（不保存），让它在重拉后仍持有 draft、保存按钮可点
    fireEvent.change(within(english).getByTestId('points-input-english_words-5'), {
      target: { value: '7' },
    });

    // A 卡保存后的重拉：给英语卡多带一个 tierKey '20'（本卡既无 draft 也未渲染）
    const newTier = {
      tierKey: '20',
      tierLabel: '20 词',
      points: 12,
      dailyLimit: null,
      isActive: true,
      completedToday: 0,
      remainingToday: null,
    };
    const withNewTier: MyPointRules = {
      tasks: RULES.tasks.map((task) =>
        task.taskCode === 'english_words' ? { ...task, tiers: [...task.tiers, newTier] } : task,
      ),
    };
    getRulesMock.mockResolvedValueOnce(withNewTier);

    const math = screen.getByTestId('point-rules-card-math_targeted');
    fireEvent.change(within(math).getByTestId('points-input-math_targeted-3'), {
      target: { value: '10' },
    });
    fireEvent.click(within(math).getByTestId('save-task-math_targeted'));
    await waitFor(() => expect(getRulesMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(saveRulesMock).toHaveBeenCalledTimes(1));

    // 英语卡没重挂载：新档位既没 draft 也不渲染
    const englishAfter = screen.getByTestId('point-rules-card-english_words');
    expect(within(englishAfter).queryByTestId('tier-row-english_words-20')).not.toBeInTheDocument();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    saveRulesMock.mockClear();
    fireEvent.click(within(englishAfter).getByTestId('save-task-english_words'));

    await waitFor(() => expect(saveRulesMock).toHaveBeenCalledTimes(1));
    const body = saveRulesMock.mock.calls[0][1];
    // 有 draft 的档位照常提交（草稿值 7，不是服务端快照 2）
    expect(body).toContainEqual({
      taskCode: 'english_words',
      tierKey: '5',
      points: 7,
      dailyLimit: null,
      isActive: true,
    });
    // 缺 draft 的新档位被跳过（不是回退快照值的假编辑）
    expect(body.some((rule) => rule.tierKey === '20')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('english_words.20'));
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
