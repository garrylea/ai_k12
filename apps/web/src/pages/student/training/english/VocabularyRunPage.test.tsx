import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import VocabularyRunPage from './VocabularyRunPage';
import {
  ApiError,
  completeTrainingSession,
  getMyPoints,
  judgeVocabularyWord,
  type CompleteTrainingSessionResult,
  type MyPoints,
  type VocabularyJudgeResult,
  type VocabularyQuestionItem,
} from '@/services/api';
import { usePointsStore } from '@/store/pointsStore';

/**
 * 背单词答题页（计划 §3 Task 7b）。
 *
 * 与数学专项同构（乙类会话页，靠 `completeTrainingSession` 发分），但**完成时机不同**：
 * 本页判题是「提交即翻页、判定异步回填」，所以完成点必须是 `finished` 变 true 的那一刻，
 * 而不是「最后一次判题返回」——最后一个词提交后马上就该发分，不能等模型。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 */
afterEach(() => {
  cleanup();
  usePointsStore.setState({ queue: [], revision: 0 });
  sessionStorage.clear();
});

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    judgeVocabularyWord: vi.fn(),
    completeTrainingSession: vi.fn(),
    getMyPoints: vi.fn(),
  };
});

const judgeMock = vi.mocked(judgeVocabularyWord);
const completeMock = vi.mocked(completeTrainingSession);
const getMyPointsMock = vi.mocked(getMyPoints);

const KEY = 'training:vocabulary';

const QUESTION: VocabularyQuestionItem = {
  wordId: 7,
  senseIndex: 0,
  promptKind: 'cn2en',
  prompt: '苹果',
  phonetic: null,
  context: null,
  isExtendedSense: false,
  hasFamily: false,
};

const JUDGED: VocabularyJudgeResult = {
  wordId: 7,
  senseIndex: 0,
  verdict: 'correct',
  method: 'exact',
  standard: {
    word: 'apple',
    phonetic: null,
    meanings: [],
    target: { pos: 'n.', gloss: '苹果', extended: false },
  },
  spellingDiff: null,
  comment: null,
  familyAvailable: false,
  progress: { learned: true, wrongCount: 0 },
};

function seed(sessionId: number | null) {
  sessionStorage.setItem(KEY, JSON.stringify({ sessionId, questions: [QUESTION] }));
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', element: <VocabularyRunPage /> }], {
    initialEntries: ['/'],
  });
  return render(<RouterProvider router={router} />);
}

/** 唯一一个词点「不认识」跳过 → 提交即完成（不等判题回填）。 */
async function finishOnlyWord() {
  renderPage();
  await act(async () => {
    fireEvent.click(screen.getByTestId('skip-button'));
  });
  await screen.findByText('本轮成绩');
}

function myPoints(levelName: string): MyPoints {
  return {
    balance: 600,
    totalEarned: 600,
    todayEarned: 20,
    level: { code: 'zhutie', name: levelName, index: 1, threshold: 500 },
    nextLevel: null,
    pointsToNextLevel: null,
    progressPercent: 100,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('VocabularyRunPage 完成发分', () => {
  beforeEach(() => {
    judgeMock.mockReset();
    completeMock.mockReset();
    getMyPointsMock.mockReset();
    judgeMock.mockResolvedValue(JUDGED);
    getMyPointsMock.mockResolvedValue(myPoints('铸铁'));
  });

  it('正常完成：最后一个词提交后立刻用 sessionId 调 complete，并 push 发分结果', async () => {
    seed(88);
    completeMock.mockResolvedValue({
      pointsAwarded: 9,
      balance: 600,
      totalEarned: 600,
      levelUp: null,
    });
    // 判题**永不返回**：若实现改成「先 await 判题再 complete」，这条会用例超时失败。
    // 本页的完成点必须是 `finished` 变 true 的那一刻——等模型回来才发分会把学生卡在成绩页。
    judgeMock.mockReturnValue(new Promise<VocabularyJudgeResult>(() => {}));

    await finishOnlyWord();

    await waitFor(() => {
      expect(completeMock).toHaveBeenCalledWith(88);
    });
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(usePointsStore.getState().queue).toHaveLength(1);
    expect(usePointsStore.getState().queue[0]).toMatchObject({
      points: 9,
      title: '英语背单词 · 1 词',
    });
  });

  it('sessionId 为 null（会话 INSERT 降级）：不调 complete、不弹反馈、不报错', async () => {
    seed(null);

    await finishOnlyWord();

    expect(completeMock).not.toHaveBeenCalled();
    expect(usePointsStore.getState().queue).toHaveLength(0);
    expect(screen.getByText('本轮成绩')).toBeTruthy();
  });

  it('balance 为 null（award_failed）：提示稍后到账 + 重试，不 push 假分；点重试再调一次 complete', async () => {
    seed(88);
    const retry = deferred<CompleteTrainingSessionResult>();
    completeMock
      .mockResolvedValueOnce({
        pointsAwarded: 0,
        balance: null,
        totalEarned: null,
        levelUp: null,
        reason: 'award_failed',
      })
      .mockReturnValueOnce(retry.promise);

    await finishOnlyWord();

    await screen.findByText('积分稍后到账，可重试');
    expect(usePointsStore.getState().queue).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
    });

    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: '重试中…' })).toBeDisabled();

    await act(async () => {
      retry.resolve({ pointsAwarded: 9, balance: 600, totalEarned: 600, levelUp: null });
    });

    await waitFor(() => {
      expect(usePointsStore.getState().queue).toHaveLength(1);
    });
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 9, title: '英语背单词 · 1 词' });
    expect(screen.queryByText('积分稍后到账，可重试')).toBeNull();
  });

  it('客户端 4xx（会话不存在 404）→ 诚实说明、不给重试按钮（重试也永远不会成功）', async () => {
    seed(88);
    completeMock.mockRejectedValue(new ApiError(1002, '训练会话不存在', undefined, 404));

    await finishOnlyWord();

    await screen.findByText('本次积分未能到账，请联系家长或稍后查看积分明细');
    expect(screen.queryByText('积分稍后到账，可重试')).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('网络异常（无 HTTP 响应）→ 仍是「积分稍后到账 + 重试」', async () => {
    seed(88);
    completeMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await finishOnlyWord();

    await screen.findByText('积分稍后到账，可重试');
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.queryByText('本次积分未能到账，请联系家长或稍后查看积分明细')).toBeNull();
  });

  it('reason 为 already_completed（幂等命中，0 分）：静默，不 push 也不弹上限文案', async () => {
    seed(88);
    completeMock.mockResolvedValue({
      pointsAwarded: 0,
      balance: 600,
      totalEarned: 600,
      levelUp: null,
      reason: 'already_completed',
    });

    await finishOnlyWord();

    await waitFor(() => {
      expect(completeMock).toHaveBeenCalledWith(88);
    });
    expect(usePointsStore.getState().queue).toHaveLength(0);
    expect(screen.queryByText('积分稍后到账，可重试')).toBeNull();
  });

  it('段位晋升：全屏庆祝而不是轻反馈（不 push toast）', async () => {
    seed(88);
    completeMock.mockResolvedValue({
      pointsAwarded: 20,
      balance: 600,
      totalEarned: 600,
      levelUp: { from: 'pichai', to: 'zhutie' },
    });

    await finishOnlyWord();

    expect(await screen.findByRole('dialog', { name: '晋升 铸铁！' })).toBeTruthy();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });
});
