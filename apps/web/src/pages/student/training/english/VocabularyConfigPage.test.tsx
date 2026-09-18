import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import VocabularyConfigPage from './VocabularyConfigPage';
import {
  fetchVocabularyOptions,
  getMyPointRules,
  startVocabulary,
  type MyPointRules,
  type PointRuleTier,
  type VocabularyOptions,
  type VocabularyQuestionItem,
} from '@/services/api';

/**
 * 背单词配置页（计划 §3 Task 6）。
 *
 * 「背几个」的档位同样来自家长配置的积分规则（`en_vocabulary`），
 * 开练 count 必须落在白名单里，否则 `/training/vocabulary/start` 会 400。
 */
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    fetchVocabularyOptions: vi.fn(),
    getMyPointRules: vi.fn(),
    startVocabulary: vi.fn(),
  };
});

const optionsMock = vi.mocked(fetchVocabularyOptions);
const getRulesMock = vi.mocked(getMyPointRules);
const startMock = vi.mocked(startVocabulary);

const OPTIONS: VocabularyOptions = {
  pools: [{ key: 'junior', label: '初中', count: 1200 }],
  todayAnswered: 0,
  counts: { notLearned: 100, myWrong: 2, commonWrong: 3, extended: 5 },
};

function tier(
  over: Pick<PointRuleTier, 'tierKey' | 'tierLabel' | 'points'> & Partial<PointRuleTier>,
): PointRuleTier {
  return { dailyLimit: null, completedToday: null, remainingToday: null, isActive: true, ...over };
}

const VOCAB_TIERS: PointRuleTier[] = [
  tier({ tierKey: '10', tierLabel: '10 词', points: 5 }),
  tier({ tierKey: '15', tierLabel: '15 词', points: 9, dailyLimit: 2, completedToday: 1, remainingToday: 1 }),
  tier({ tierKey: '20', tierLabel: '20 词', points: 15, dailyLimit: 1, completedToday: 1, remainingToday: 0 }),
  // 有上限但「今日次数」未计算：remainingToday === null → 不应显示任何状态文案
  tier({ tierKey: '12', tierLabel: '12 词', points: 6, dailyLimit: 3, completedToday: 0, remainingToday: null }),
];

/** 抽词成功返回的词单（happy path 默认值；空结果另一条分支单独覆盖）。 */
const STARTED_WORD: VocabularyQuestionItem = {
  wordId: 7,
  senseIndex: 0,
  promptKind: 'cn2en',
  prompt: '苹果',
  phonetic: null,
  context: null,
  isExtendedSense: false,
  hasFamily: false,
};

/** 别的任务排在前面：按 taskCode 挑，而不是拿 tasks[0]。 */
function rulesOf(tiers: PointRuleTier[]): MyPointRules {
  return {
    tasks: [
      { taskCode: 'math_targeted', taskName: '数学专项', tiers: [tier({ tierKey: '3', tierLabel: '3 题', points: 8 })] },
      { taskCode: 'en_vocabulary', taskName: '英语背单词', tiers },
    ],
  };
}

/** 词库信息与档位都在 useEffect 里异步拉取，render 必须包在 act 里等它们落地。 */
async function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/', element: <VocabularyConfigPage /> },
      // 开背成功会 navigate 到 run 页；这里要有落点，否则测试环境报「无匹配路由」
      { path: '/student/training/english/vocabulary/run', element: <div /> },
    ],
    { initialEntries: ['/'] },
  );
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RouterProvider router={router} />);
  });
  return result;
}

async function clickStart() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /开始背词/ }));
  });
}

describe('VocabularyConfigPage 词量档位', () => {
  beforeEach(() => {
    optionsMock.mockReset();
    getRulesMock.mockReset();
    startMock.mockReset();
    optionsMock.mockResolvedValue(OPTIONS);
    getRulesMock.mockResolvedValue(rulesOf(VOCAB_TIERS));
    startMock.mockResolvedValue({ questions: [STARTED_WORD], poolSize: 1, sessionId: 88 });
  });

  it('档位渲染自 me/rules：按 taskCode 取档，每档显示分值，有上限的显示剩余次数', async () => {
    await renderPage();

    for (const label of ['10 词', '15 词', '20 词']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
    // 不是 tasks[0]（数学档位）串进来
    expect(screen.queryByRole('button', { name: /^3 题/ })).toBeNull();

    expect(screen.getByText('+5 分')).toBeTruthy();
    expect(screen.getByText('+9 分 · 剩余 1 次')).toBeTruthy();
    expect(screen.getByText('+15 分 · 今日已达上限')).toBeTruthy();
  });

  it('默认选中第一个档位，开练 count 用该档位的数值', async () => {
    await renderPage();
    expect(screen.getByRole('button', { name: /^10 词/ }).getAttribute('aria-pressed')).toBe('true');

    await clickStart();

    expect(startMock).toHaveBeenCalledWith(expect.objectContaining({ count: 10 }));
  });

  it('remainingToday === 0 的档位置灰但**仍可开练**，count 用该档数值', async () => {
    await renderPage();
    const capped = screen.getByRole('button', { name: /^20 词/ });
    expect(screen.getByText('+15 分 · 今日已达上限')).toBeTruthy();
    expect(capped).not.toBeDisabled();

    fireEvent.click(capped);
    expect(capped.getAttribute('aria-pressed')).toBe('true');

    await clickStart();

    expect(startMock).toHaveBeenCalledWith(expect.objectContaining({ count: 20 }));
  });

  it('dailyLimit 有值但 remainingToday 未计算：不显示状态文案，按钮仍可点并用于开练', async () => {
    await renderPage();
    const notComputed = screen.getByRole('button', { name: /^12 词/ });

    expect(within(notComputed).getByText('+6 分')).toBeTruthy();
    expect(within(notComputed).queryByText(/剩余 \d+ 次|今日已达上限/)).toBeNull();
    expect(notComputed).not.toBeDisabled();

    fireEvent.click(notComputed);
    expect(notComputed.getAttribute('aria-pressed')).toBe('true');

    await clickStart();

    expect(startMock).toHaveBeenCalledWith(expect.objectContaining({ count: 12 }));
  });

  it('空 tiers：显示「家长已停用该任务」，不给默认值、开练禁用', async () => {
    getRulesMock.mockResolvedValue(rulesOf([]));
    await renderPage();

    expect(screen.getByText('家长已停用该任务')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^10 词/ })).toBeNull();
    expect(screen.getByRole('button', { name: /开始背词/ })).toBeDisabled();

    await clickStart();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('档位未到之前只显示骨架，不先渲染旧常量', async () => {
    getRulesMock.mockReturnValue(new Promise(() => {}));
    await renderPage();

    expect(screen.getByTestId('tier-skeleton')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^10 词/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^20 词/ })).toBeNull();
  });

  it('档位拉取失败：错误态 + 重试，不用旧常量兜底', async () => {
    getRulesMock.mockRejectedValueOnce(new Error('network down'));
    await renderPage();

    expect(screen.getByText('档位加载失败，请重试')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^15 词/ })).toBeNull();
    expect(screen.getByRole('button', { name: /开始背词/ })).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
    });

    expect(getRulesMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /^15 词/ })).toBeTruthy();
  });
});

describe('VocabularyConfigPage sessionId 交接链', () => {
  beforeEach(() => {
    optionsMock.mockReset();
    getRulesMock.mockReset();
    startMock.mockReset();
    optionsMock.mockResolvedValue(OPTIONS);
    getRulesMock.mockResolvedValue(rulesOf(VOCAB_TIERS));
    startMock.mockResolvedValue({ questions: [STARTED_WORD], poolSize: 1, sessionId: 88 });
  });

  it('开背成功后 sessionStorage 存 { sessionId, questions }（run 页据此发分）', async () => {
    await renderPage();
    await clickStart();

    const stored: unknown = JSON.parse(sessionStorage.getItem('training:vocabulary') ?? 'null');
    expect(stored).toEqual({ sessionId: 88, questions: [STARTED_WORD] });
  });

  it('start 降级返回 sessionId: null 时原样交接（run 页据此不发分）', async () => {
    startMock.mockResolvedValue({ questions: [STARTED_WORD], poolSize: 1, sessionId: null });
    await renderPage();
    await clickStart();

    const stored: unknown = JSON.parse(sessionStorage.getItem('training:vocabulary') ?? 'null');
    expect(stored).toEqual({ sessionId: null, questions: [STARTED_WORD] });
  });
});
