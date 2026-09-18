import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { getMyPointRules, type MyPointRules, type PointRuleTier } from '@/services/api';
import { TIER_LOAD_ERROR, tierStatus, usePointTiers } from './point-tiers';

/**
 * 档位共享模块（数学专项 / 背单词两个配置页共用）。
 *
 * 存在意义：`remainingToday === 0` 只置灰不禁用、空 `tiers` 不给默认值这两条是
 * 产品硬规则（计划 §1.1#2 / §3 Task 6）。规则若只写在页面里，两个页面各一份、
 * 没有跨文件测试，改一处漏一处就会对同一后端数据表现不同。这里直接钉住纯函数与 hook。
 * 页面级渲染（骨架/错误态/开练禁用）仍由两个页面自己的测试覆盖。
 */
afterEach(() => cleanup());

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getMyPointRules: vi.fn() };
});

const getRulesMock = vi.mocked(getMyPointRules);

function tier(
  over: Pick<PointRuleTier, 'tierKey' | 'tierLabel' | 'points'> & Partial<PointRuleTier>,
): PointRuleTier {
  return { dailyLimit: null, completedToday: null, remainingToday: null, ...over };
}

/** 别的任务排在前面：确保是按 taskCode 挑，而不是拿 tasks[0]。 */
function rulesOf(taskCode: string, tiers: PointRuleTier[]): MyPointRules {
  return {
    tasks: [
      { taskCode: 'other_task', taskName: '别的任务', tiers: [tier({ tierKey: '9', tierLabel: '9 题', points: 1 })] },
      { taskCode, taskName: '目标任务', tiers },
    ],
  };
}

describe('tierStatus', () => {
  it('不限次数（dailyLimit == null）→ 无状态文案、不置灰', () => {
    expect(tierStatus(tier({ tierKey: '1', tierLabel: '1 题', points: 3 }))).toEqual({
      text: null,
      capped: false,
    });
  });

  it('有上限但今日次数未计算（remainingToday == null）→ 无状态文案、不置灰', () => {
    expect(
      tierStatus(
        tier({ tierKey: '2', tierLabel: '2 题', points: 5, dailyLimit: 3, completedToday: 0, remainingToday: null }),
      ),
    ).toEqual({ text: null, capped: false });
  });

  it('remainingToday === 0 → 「今日已达上限」且 capped（仅置灰，不禁用由调用方保证）', () => {
    expect(
      tierStatus(
        tier({ tierKey: '5', tierLabel: '5 题', points: 12, dailyLimit: 2, completedToday: 2, remainingToday: 0 }),
      ),
    ).toEqual({ text: '今日已达上限', capped: true });
  });

  it('remainingToday > 0 → 「剩余 N 次」且不 capped', () => {
    expect(
      tierStatus(
        tier({ tierKey: '3', tierLabel: '3 题', points: 8, dailyLimit: 2, completedToday: 1, remainingToday: 1 }),
      ),
    ).toEqual({ text: '剩余 1 次', capped: false });
  });
});

describe('usePointTiers', () => {
  beforeEach(() => {
    getRulesMock.mockReset();
  });

  it('初始 tiers == null（预解析 = 骨架），按 taskCode 取档并默认选中第一档', async () => {
    getRulesMock.mockResolvedValue(
      rulesOf('math_targeted', [
        tier({ tierKey: '1', tierLabel: '1 题', points: 3 }),
        tier({ tierKey: '3', tierLabel: '3 题', points: 8 }),
      ]),
    );
    const { result } = renderHook(() => usePointTiers('math_targeted'));

    // 请求还没回来：null 而不是 [] —— 页面靠这个区分「骨架」与「家长已停用」
    expect(result.current.tiers).toBeNull();
    expect(result.current.tierKey).toBeNull();

    await act(async () => {});

    expect(result.current.tiers).toHaveLength(2);
    expect(result.current.tierKey).toBe('1');
    expect(result.current.error).toBeNull();
  });

  it('空 tiers → tierKey 保持 null（绝不发明 tiers[0] 默认值）', async () => {
    getRulesMock.mockResolvedValue(rulesOf('math_targeted', []));
    const { result } = renderHook(() => usePointTiers('math_targeted'));

    await act(async () => {});

    expect(result.current.tiers).toEqual([]);
    expect(result.current.tierKey).toBeNull();
  });

  it('任务组缺失（taskCode 改名/漏发）→ 退化为空档位而非抛错，不报 error', async () => {
    getRulesMock.mockResolvedValue(rulesOf('math_targeted', [tier({ tierKey: '1', tierLabel: '1 题', points: 3 })]));
    const { result } = renderHook(() => usePointTiers('renamed_task'));

    await act(async () => {});

    expect(result.current.tiers).toEqual([]);
    expect(result.current.tierKey).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('拉取失败 → error 文案 + 档位清空；retry 先清 error 回到骨架再成功', async () => {
    let rejectFirst!: (err: unknown) => void;
    getRulesMock.mockImplementationOnce(
      () => new Promise<MyPointRules>((_, reject) => { rejectFirst = reject; }),
    );
    const { result } = renderHook(() => usePointTiers('math_targeted'));

    await act(async () => { rejectFirst(new Error('network down')); });

    expect(result.current.error).toBe(TIER_LOAD_ERROR);
    expect(result.current.tiers).toBeNull();
    expect(result.current.tierKey).toBeNull();

    // 第二次请求挂住：retry 已同步清掉 error，所以此刻是骨架态（不是错误页）
    let resolveSecond!: (value: MyPointRules) => void;
    getRulesMock.mockImplementationOnce(
      () => new Promise<MyPointRules>((resolve) => { resolveSecond = resolve; }),
    );
    act(() => { result.current.retry(); });

    expect(result.current.error).toBeNull();
    expect(result.current.tiers).toBeNull();

    await act(async () => {
      resolveSecond(rulesOf('math_targeted', [tier({ tierKey: '10', tierLabel: '10 题', points: 20 })]));
    });

    expect(getRulesMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.tiers).toHaveLength(1);
    expect(result.current.tierKey).toBe('10');
  });
});
