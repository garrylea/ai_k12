import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { getMyPoints, type MyPoints } from '@/services/api';
import { usePointsStore } from '@/store/pointsStore';
import { decidePointsFeedback, usePointsFeedback } from './points-feedback';

/**
 * 积分反馈共享模块（甲类四页 + 两个会话页 + 交卷页共用一份「什么该弹、什么该静默」的决策）。
 *
 * 这里钉住的是一条最容易写错的规则：`pointsAwarded === 0` **不等于**「已达上限」。
 * Task 2 的 `PointsToast` 对 `points <= 0` 一律渲染「今日该任务积分已达上限」，
 * 所以幂等命中（无 reason）必须在决策层静默 —— 直接 push 会弹假文案（计划 §1.1#4）。
 *
 * vitest globals:false：必须显式 import + 自己写 afterEach(cleanup)。
 */
afterEach(() => {
  cleanup();
  // store 是模块级单例，用例之间要清空队列，否则上一条的 toast 串到下一条
  usePointsStore.setState({ queue: [], revision: 0 });
});

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getMyPoints: vi.fn() };
});

const getMyPointsMock = vi.mocked(getMyPoints);

/** 概览只用到 `level.name`；其余字段与用例无关，给最小可用值。 */
function myPoints(levelName: string): MyPoints {
  return {
    balance: 520,
    totalEarned: 520,
    todayEarned: 20,
    level: { code: 'zhutie', name: levelName, index: 1, threshold: 500 },
    nextLevel: null,
    pointsToNextLevel: null,
    progressPercent: 100,
  };
}

describe('decidePointsFeedback', () => {
  it('正分 + levelUp → 全屏庆祝（不是轻反馈）', () => {
    expect(
      decidePointsFeedback({
        pointsAwarded: 20,
        levelUp: { from: 'pichai', to: 'zhutie' },
        title: '数学专项 · 10 题',
      }),
    ).toEqual({ kind: 'levelup' });
  });

  it('正分、无 levelUp → 轻反馈', () => {
    expect(decidePointsFeedback({ pointsAwarded: 5, title: '英语背单词 · 10 词' })).toEqual({
      kind: 'toast',
      points: 5,
    });
  });

  it('levelUp 显式为 null → 仍是轻反馈（不庆祝）', () => {
    expect(
      decidePointsFeedback({ pointsAwarded: 3, levelUp: null, title: '默写' }),
    ).toEqual({ kind: 'toast', points: 3 });
  });

  it('正分 + celebrate（交卷大任务）→ task 全屏庆祝，不是轻反馈', () => {
    expect(
      decidePointsFeedback({
        pointsAwarded: 12,
        celebrate: { title: '本次测验完成！' },
        title: '数学测验',
      }),
    ).toEqual({ kind: 'task' });
  });

  it('正分 + celebrate + levelUp → levelup 优先（晋升是更大的消息）', () => {
    expect(
      decidePointsFeedback({
        pointsAwarded: 12,
        levelUp: { from: 'pichai', to: 'zhutie' },
        celebrate: { title: '本次测验完成！' },
        title: '数学测验',
      }),
    ).toEqual({ kind: 'levelup' });
  });

  it('0 分 + daily_limit + celebrate → 仍只弹 0 分轻反馈，celebrate 不生效', () => {
    expect(
      decidePointsFeedback({
        pointsAwarded: 0,
        awardReason: 'daily_limit',
        celebrate: { title: '本次测验完成！' },
        title: '数学测验',
      }),
    ).toEqual({ kind: 'toast', points: 0 });
  });

  it('0 分 + 无 reason + celebrate → 静默（幂等交卷不庆祝）', () => {
    expect(
      decidePointsFeedback({
        pointsAwarded: 0,
        celebrate: { title: '本次测验完成！' },
        title: '数学测验',
      }),
    ).toEqual({ kind: 'silent' });
  });

  it('0 分 + daily_limit → 轻反馈 0 分（渲染「今日该任务积分已达上限」）', () => {
    expect(
      decidePointsFeedback({ pointsAwarded: 0, awardReason: 'daily_limit', title: '数学专项 · 5 题' }),
    ).toEqual({ kind: 'toast', points: 0 });
  });

  it('0 分 + 无 reason（幂等命中）→ 静默，绝不 push（否则弹假上限文案）', () => {
    expect(decidePointsFeedback({ pointsAwarded: 0, title: '数学专项 · 5 题' })).toEqual({
      kind: 'silent',
    });
  });

  it.each(['not_cleared', 'no_rule', 'tier_inactive', 'genre_unset'] as const)(
    '0 分 + %s → 静默',
    (awardReason) => {
      expect(decidePointsFeedback({ pointsAwarded: 0, awardReason, title: '课堂练习' })).toEqual({
        kind: 'silent',
      });
    },
  );

  it('0 分 + levelUp（异常组合，不该发生）→ 静默，不庆祝也不弹假文案', () => {
    expect(
      decidePointsFeedback({
        pointsAwarded: 0,
        levelUp: { from: 'pichai', to: 'zhutie' },
        title: '数学专项 · 5 题',
      }),
    ).toEqual({ kind: 'silent' });
  });

  it('award_failed 不在入参类型内（归调用方重试），万一传进来也静默', () => {
    // 类型钉子：谁把 `award_failed` 并进 PointsFeedbackInput，`npm run build` 会在这行报错
    // @ts-expect-error award_failed 刻意不属于本模块的入参
    const decision = decidePointsFeedback({ pointsAwarded: 0, awardReason: 'award_failed', title: '完成' });
    // 运行时兜底：绕过类型传进来也不能弹「今日该任务积分已达上限」的假文案
    expect(decision).toEqual({ kind: 'silent' });
  });
});

describe('usePointsFeedback', () => {
  beforeEach(() => {
    getMyPointsMock.mockReset();
    usePointsStore.setState({ queue: [], revision: 0 });
  });

  it('正分 + levelUp → 打开全屏庆祝、不 push 轻反馈，段位名从 getMyPoints 取', async () => {
    getMyPointsMock.mockResolvedValue(myPoints('铸铁'));
    const { result } = renderHook(() => usePointsFeedback());

    await act(async () => {
      result.current.award({
        pointsAwarded: 20,
        levelUp: { from: 'pichai', to: 'zhutie' },
        title: '数学专项 · 10 题',
      });
    });

    // 计划 §2.2：晋升只在全屏庆祝，绝不与轻反馈同弹
    expect(usePointsStore.getState().queue).toHaveLength(0);
    expect(result.current.celebrationProps.open).toBe(true);
    expect(result.current.celebrationProps.variant).toBe('levelup');
    expect(result.current.celebrationProps.pointsAwarded).toBe(20);
    expect(result.current.celebrationProps.level?.code).toBe('zhutie');
    expect(result.current.celebrationProps.title).toBe('晋升 铸铁！');
    expect(result.current.celebrationProps.level?.name).toBe('铸铁');
  });

  it('getMyPoints 失败 → 不崩，仍出全屏庆祝（只显示图标、标题降级）', async () => {
    getMyPointsMock.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => usePointsFeedback());

    await act(async () => {
      result.current.award({
        pointsAwarded: 20,
        levelUp: { from: 'pichai', to: 'zhutie' },
        title: '数学专项 · 10 题',
      });
    });

    expect(result.current.celebrationProps.open).toBe(true);
    expect(result.current.celebrationProps.level?.code).toBe('zhutie');
    // 空名字 → CelebrationOverlay 不渲染段位名文字，但大图标照常显示
    expect(result.current.celebrationProps.level?.name).toBe('');
    expect(result.current.celebrationProps.title).toBe('晋升新段位！');
    expect(result.current.celebrationProps.title).not.toContain('undefined');
  });

  it('段位名迟到不覆盖后一次庆祝（旧请求回来时 code 已不同）', async () => {
    let resolveFirst!: (value: MyPoints) => void;
    getMyPointsMock.mockImplementationOnce(
      () => new Promise<MyPoints>((resolve) => { resolveFirst = resolve; }),
    );
    const { result } = renderHook(() => usePointsFeedback());

    await act(async () => {
      result.current.award({
        pointsAwarded: 20,
        levelUp: { from: 'pichai', to: 'zhutie' },
        title: '第一次',
      });
    });

    getMyPointsMock.mockResolvedValue(myPoints('青铜'));
    await act(async () => {
      result.current.award({
        pointsAwarded: 30,
        levelUp: { from: 'zhutie', to: 'qingtong' },
        title: '第二次',
      });
    });
    expect(result.current.celebrationProps.level?.code).toBe('qingtong');

    // 第一次的响应这时才回来：不能把庆祝层改回铸铁
    await act(async () => { resolveFirst(myPoints('铸铁')); });
    expect(result.current.celebrationProps.level?.code).toBe('qingtong');
    expect(result.current.celebrationProps.level?.name).toBe('青铜');
  });

  it('正分无 levelUp → push 一次轻反馈，参数正确；不打开庆祝', async () => {
    const { result } = renderHook(() => usePointsFeedback());

    act(() => {
      result.current.award({ pointsAwarded: 5, title: '英语背单词 · 10 词' });
    });

    expect(getMyPointsMock).not.toHaveBeenCalled();
    expect(usePointsStore.getState().queue).toHaveLength(1);
    expect(usePointsStore.getState().queue[0]).toMatchObject({
      points: 5,
      title: '英语背单词 · 10 词',
    });
    expect(result.current.celebrationProps.open).toBe(false);
  });

  it('正分 + levelUp → 不 push 轻反馈，但 bumpRevision（发分无 toast 路径必须刷新徽章）', async () => {
    getMyPointsMock.mockResolvedValue(myPoints('铸铁'));
    const { result } = renderHook(() => usePointsFeedback());
    const before = usePointsStore.getState().revision;

    await act(async () => {
      result.current.award({
        pointsAwarded: 20,
        levelUp: { from: 'pichai', to: 'zhutie' },
        title: '数学专项 · 10 题',
      });
    });

    expect(usePointsStore.getState().queue).toHaveLength(0);
    expect(usePointsStore.getState().revision).toBe(before + 1);
    expect(result.current.celebrationProps.open).toBe(true);
  });

  it('正分 + celebrate（task 全屏）→ 不 push 轻反馈，但 bumpRevision', () => {
    const { result } = renderHook(() => usePointsFeedback());
    const before = usePointsStore.getState().revision;

    act(() => {
      result.current.award({
        pointsAwarded: 12,
        celebrate: { title: '本次测验完成！' },
        title: '数学测验',
      });
    });

    expect(usePointsStore.getState().queue).toHaveLength(0);
    expect(usePointsStore.getState().revision).toBe(before + 1);
    expect(result.current.celebrationProps.open).toBe(true);
  });

  it('0 分静默（幂等命中）→ 既不入队也不 bumpRevision（没入账就没有可刷新的余额）', () => {
    const { result } = renderHook(() => usePointsFeedback());
    const before = usePointsStore.getState().revision;

    act(() => {
      result.current.award({ pointsAwarded: 0, title: '数学专项 · 5 题' });
    });

    expect(usePointsStore.getState().queue).toHaveLength(0);
    expect(usePointsStore.getState().revision).toBe(before);
    expect(result.current.celebrationProps.open).toBe(false);
  });

  it('正分 + celebrate → 全屏 task 庆祝（标题/副标题/主按钮/积分），不 push 轻反馈', () => {
    const { result } = renderHook(() => usePointsFeedback());

    act(() => {
      result.current.award({
        pointsAwarded: 12,
        celebrate: { title: '本次测验完成！', subtitle: '正确 18 / 20', primaryLabel: '查看结果' },
        title: '数学测验',
      });
    });

    // 计划 §2.2：大任务只有全屏庆祝，不与轻反馈同弹
    expect(usePointsStore.getState().queue).toHaveLength(0);
    // task 庆祝不需要段位名，不该多打一次概览请求
    expect(getMyPointsMock).not.toHaveBeenCalled();
    expect(result.current.celebrationProps).toMatchObject({
      open: true,
      variant: 'task',
      title: '本次测验完成！',
      subtitle: '正确 18 / 20',
      primaryLabel: '查看结果',
      pointsAwarded: 12,
    });
    // task 不显示段位图标
    expect(result.current.celebrationProps.level).toBeUndefined();

    // onPrimary 直接关闭庆祝层，调用方摊开即可，无需自己接
    act(() => { result.current.celebrationProps.onPrimary(); });
    expect(result.current.celebrationProps.open).toBe(false);
  });

  it('celebrate 不带 primaryLabel → 默认「继续」', () => {
    const { result } = renderHook(() => usePointsFeedback());

    act(() => {
      result.current.award({
        pointsAwarded: 8,
        celebrate: { title: '本次测验完成！' },
        title: '数学测验',
      });
    });

    expect(result.current.celebrationProps.primaryLabel).toBe('继续');
  });

  it('正分 + celebrate + levelUp → levelup 全屏优先（标题/按钮归晋升），但保留 celebrate 的副标题，也不 push', async () => {
    getMyPointsMock.mockResolvedValue(myPoints('铸铁'));
    const { result } = renderHook(() => usePointsFeedback());

    await act(async () => {
      result.current.award({
        pointsAwarded: 20,
        levelUp: { from: 'pichai', to: 'zhutie' },
        celebrate: { title: '本次测验完成！', subtitle: '正确 18 / 20' },
        title: '数学测验',
      });
    });

    expect(usePointsStore.getState().queue).toHaveLength(0);
    expect(result.current.celebrationProps.variant).toBe('levelup');
    expect(result.current.celebrationProps.title).toBe('晋升 铸铁！');
    // 交卷同时晋升不能把分数藏掉（计划 §3 Task 7c「分数与积分都要显示」）
    expect(result.current.celebrationProps.subtitle).toBe('正确 18 / 20');
    expect(result.current.celebrationProps.pointsAwarded).toBe(20);
  });

  it('正分 + levelUp 但没传 celebrate（会话页 / 甲类页）→ levelup 无副标题', async () => {
    getMyPointsMock.mockResolvedValue(myPoints('铸铁'));
    const { result } = renderHook(() => usePointsFeedback());

    await act(async () => {
      result.current.award({
        pointsAwarded: 20,
        levelUp: { from: 'pichai', to: 'zhutie' },
        title: '数学专项 · 10 题',
      });
    });

    expect(result.current.celebrationProps.variant).toBe('levelup');
    expect(result.current.celebrationProps.subtitle).toBeUndefined();
  });

  it('celebrate + 0 分 daily_limit → 只 push 0 分轻反馈，不庆祝', () => {
    const { result } = renderHook(() => usePointsFeedback());

    act(() => {
      result.current.award({
        pointsAwarded: 0,
        awardReason: 'daily_limit',
        celebrate: { title: '本次测验完成！' },
        title: '数学测验',
      });
    });

    expect(usePointsStore.getState().queue).toHaveLength(1);
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 0, title: '数学测验' });
    expect(result.current.celebrationProps.open).toBe(false);
  });

  it('celebrate + 0 分无 reason（幂等交卷）→ 静默，不 push 也不庆祝', () => {
    const { result } = renderHook(() => usePointsFeedback());

    act(() => {
      result.current.award({
        pointsAwarded: 0,
        celebrate: { title: '本次测验完成！' },
        title: '数学测验',
      });
    });

    expect(usePointsStore.getState().queue).toHaveLength(0);
    expect(result.current.celebrationProps.open).toBe(false);
  });

  it('0 分 + daily_limit → push points: 0（PointsToast 渲染上限文案）', () => {
    const { result } = renderHook(() => usePointsFeedback());

    act(() => {
      result.current.award({ pointsAwarded: 0, awardReason: 'daily_limit', title: '数学专项 · 5 题' });
    });

    expect(usePointsStore.getState().queue).toHaveLength(1);
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 0, title: '数学专项 · 5 题' });
    expect(result.current.celebrationProps.open).toBe(false);
  });

  it.each(['not_cleared', 'no_rule', 'tier_inactive', 'genre_unset'] as const)(
    '0 分 + %s → 不 push、不庆祝',
    (awardReason) => {
      const { result } = renderHook(() => usePointsFeedback());

      act(() => {
        result.current.award({ pointsAwarded: 0, awardReason, title: '课堂练习' });
      });

      expect(usePointsStore.getState().queue).toHaveLength(0);
      expect(result.current.celebrationProps.open).toBe(false);
    },
  );

  it('0 分 + 无 reason（甲类逐句判题的中间句 / 幂等命中）→ 不 push', () => {
    const { result } = renderHook(() => usePointsFeedback());

    act(() => {
      result.current.award({ pointsAwarded: 0, title: '古诗文解释 · 第 2 句' });
    });

    expect(usePointsStore.getState().queue).toHaveLength(0);
    expect(result.current.celebrationProps.open).toBe(false);
  });

  it('closeCelebration → 庆祝层关闭', async () => {
    getMyPointsMock.mockResolvedValue(myPoints('铸铁'));
    const { result } = renderHook(() => usePointsFeedback());

    await act(async () => {
      result.current.award({
        pointsAwarded: 20,
        levelUp: { from: 'pichai', to: 'zhutie' },
        title: '数学专项 · 10 题',
      });
    });
    expect(result.current.celebrationProps.open).toBe(true);

    act(() => { result.current.closeCelebration(); });
    expect(result.current.celebrationProps.open).toBe(false);
  });
});
