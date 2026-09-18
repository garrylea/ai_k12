import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import TargetedConfigPage from './TargetedConfigPage';
import {
  getKnowledgePoints,
  getMyPointRules,
  startTargetedPractice,
  type MyPointRules,
  type PointRuleTier,
  type TrainingKnowledgePoint,
} from '@/services/api';

/**
 * 数学专项配置页（计划 §3 Task 6）。
 *
 * 为什么必须改读接口：计划一给 `/training/targeted/start` 加了**档位白名单**，
 * 白名单来自家长配置的 `(taskCode, tierKey)`；新默认档位是 1/3/5/10。
 * 旧常量里的「8 题」现在会被 400 拒绝，所以档位只能来自 `me/rules`。
 */
afterEach(() => cleanup());

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getKnowledgePoints: vi.fn(),
    getMyPointRules: vi.fn(),
    startTargetedPractice: vi.fn(),
  };
});

const getKpsMock = vi.mocked(getKnowledgePoints);
const getRulesMock = vi.mocked(getMyPointRules);
const startMock = vi.mocked(startTargetedPractice);

const KPS: TrainingKnowledgePoint[] = [
  { id: 1, name: '数与代数', parentKpId: null, gradeBand: 'junior' },
  { id: 2, name: '一元二次方程', parentKpId: 1, gradeBand: 'junior' },
];

function tier(
  over: Pick<PointRuleTier, 'tierKey' | 'tierLabel' | 'points'> & Partial<PointRuleTier>,
): PointRuleTier {
  return { dailyLimit: null, completedToday: null, remainingToday: null, ...over };
}

const MATH_TIERS: PointRuleTier[] = [
  tier({ tierKey: '1', tierLabel: '1 题', points: 3 }),
  tier({ tierKey: '3', tierLabel: '3 题', points: 8, dailyLimit: 2, completedToday: 1, remainingToday: 1 }),
  tier({ tierKey: '5', tierLabel: '5 题', points: 12, dailyLimit: 2, completedToday: 2, remainingToday: 0 }),
  tier({ tierKey: '10', tierLabel: '10 题', points: 20, dailyLimit: 1, completedToday: 1, remainingToday: 0 }),
];

/** 别的任务排在前面：按 taskCode 挑，而不是拿 tasks[0]。 */
function rulesOf(tiers: PointRuleTier[]): MyPointRules {
  return {
    tasks: [
      {
        taskCode: 'en_vocabulary',
        taskName: '英语背单词',
        tiers: [tier({ tierKey: '15', tierLabel: '15 词', points: 9 })],
      },
      { taskCode: 'math_targeted', taskName: '数学专项', tiers },
    ],
  };
}

/** 知识点与档位都在 useEffect 里异步拉取，render 必须包在 act 里等它们落地。 */
async function renderPage() {
  const router = createMemoryRouter([{ path: '/', element: <TargetedConfigPage /> }], {
    initialEntries: ['/'],
  });
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RouterProvider router={router} />);
  });
  return result;
}

function selectKps() {
  fireEvent.click(screen.getByRole('button', { name: '数与代数' }));
  fireEvent.click(screen.getByRole('button', { name: '一元二次方程' }));
}

async function clickStart() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));
  });
}

describe('TargetedConfigPage 题量档位', () => {
  beforeEach(() => {
    getKpsMock.mockReset();
    getRulesMock.mockReset();
    startMock.mockReset();
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    startMock.mockResolvedValue({ questions: [] });
  });

  it('档位渲染自 me/rules：按 taskCode 取档，每档显示分值，有上限的显示剩余次数', async () => {
    await renderPage();

    for (const label of ['1 题', '3 题', '5 题', '10 题']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
    // 不再硬编码 3/5/8/10 —— 8 现在会被后端 400
    expect(screen.queryByRole('button', { name: /^8 题/ })).toBeNull();
    // 不是 tasks[0]（英语档位）串进来
    expect(screen.queryByRole('button', { name: /15 词/ })).toBeNull();

    expect(screen.getByText('+3 分')).toBeTruthy();
    expect(screen.getByText('+8 分 · 剩余 1 次')).toBeTruthy();
    expect(screen.getByText('+12 分 · 今日已达上限')).toBeTruthy();
    expect(screen.getByText('+20 分 · 今日已达上限')).toBeTruthy();
  });

  it('默认选中第一个档位，开练 count 用该档位的数值', async () => {
    await renderPage();
    expect(screen.getByRole('button', { name: /^1 题/ }).getAttribute('aria-pressed')).toBe('true');

    selectKps();
    await clickStart();

    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: 1, kpId: 2, count: 1 }),
    );
  });

  it('remainingToday === 0 的档位置灰但**仍可开练**，count 用该档数值', async () => {
    await renderPage();
    const capped = screen.getByRole('button', { name: /^5 题/ });
    expect(screen.getByText('+12 分 · 今日已达上限')).toBeTruthy();
    expect(capped).not.toBeDisabled();

    fireEvent.click(capped);
    expect(capped.getAttribute('aria-pressed')).toBe('true');

    selectKps();
    await clickStart();

    expect(startMock).toHaveBeenCalledWith(expect.objectContaining({ count: 5 }));
  });

  it('空 tiers：显示「家长已停用该任务」，不给默认值、开练禁用', async () => {
    getRulesMock.mockResolvedValue(rulesOf([]));
    await renderPage();

    expect(screen.getByText('家长已停用该任务')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^1 题/ })).toBeNull();

    const start = screen.getByRole('button', { name: '开始练习' });
    expect(start).toBeDisabled();
    selectKps();
    expect(start).toBeDisabled();
    await clickStart();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('档位未到之前只显示骨架，不先渲染旧常量', async () => {
    getRulesMock.mockReturnValue(new Promise(() => {}));
    await renderPage();

    expect(screen.getByTestId('tier-skeleton')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^3 题/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^8 题/ })).toBeNull();
  });

  it('档位拉取失败：错误态 + 重试，不用旧常量兜底', async () => {
    getRulesMock.mockRejectedValueOnce(new Error('network down'));
    await renderPage();

    expect(screen.getByText('档位加载失败，请重试')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^5 题/ })).toBeNull();
    expect(screen.getByRole('button', { name: '开始练习' })).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
    });

    expect(getRulesMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /^10 题/ })).toBeTruthy();
  });
});
