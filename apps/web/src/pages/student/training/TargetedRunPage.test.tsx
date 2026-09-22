import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import TargetedRunPage from './TargetedRunPage';
import {
  completeTrainingSession,
  generateRemediationSet,
  getMyPoints,
  getTrainingExplanations,
  judgeTraining,
  type CompleteTrainingSessionResult,
  type JudgeResult,
  type MyPoints,
  type TargetedPracticeQuestion,
} from '@/services/api';
import { usePointsStore } from '@/store/pointsStore';

/**
 * 数学专项答题页（计划 §3 Task 7b）。
 *
 * 本页是**乙类会话页**：分数不在判题响应里，收尾时必须拿配置页交接过来的
 * `sessionId` 调 `completeTrainingSession` 才会发分。所以这里钉住三件事：
 * 交接链把 `sessionId` 带到了本页、完成时用它发了一次分、以及发分失败/幂等/降级三条路不弹假反馈。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 */
afterEach(() => {
  cleanup();
  // store 是模块级单例，用例之间要清空队列，否则上一条的 toast 串到下一条
  usePointsStore.setState({ queue: [], revision: 0 });
  sessionStorage.clear();
});

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    judgeTraining: vi.fn(),
    getTrainingExplanations: vi.fn(),
    completeTrainingSession: vi.fn(),
    getMyPoints: vi.fn(),
    generateRemediationSet: vi.fn(),
  };
});

const judgeMock = vi.mocked(judgeTraining);
const completeMock = vi.mocked(completeTrainingSession);
const explanationsMock = vi.mocked(getTrainingExplanations);
const getMyPointsMock = vi.mocked(getMyPoints);
const generateMock = vi.mocked(generateRemediationSet);

const KEY = 'training:targeted';

const QUESTION: TargetedPracticeQuestion = {
  questionId: 101,
  text: '1 + 1 = ?',
  type: 'choice',
  options: ['A. 1', 'B. 2'],
};

const JUDGED: JudgeResult = {
  questionId: 101,
  isCorrect: true,
  method: 'exact',
  pointsAwarded: 0,
};

function seed(sessionId: number | null) {
  sessionStorage.setItem(KEY, JSON.stringify({ sessionId, questions: [QUESTION] }));
}

/** RunExitGuard 用 useBlocker —— 必须是 data router（createMemoryRouter）。 */
function renderPage() {
  const router = createMemoryRouter([{ path: '/', element: <TargetedRunPage /> }], {
    initialEntries: ['/'],
  });
  return render(<RouterProvider router={router} />);
}

/** 答完唯一一题（点选 B）并提交 → QuestionRunner 收尾 → handleFinish。 */
async function answerOnlyQuestion() {
  renderPage();
  fireEvent.click(screen.getAllByRole('radio')[1]);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
  });
  // 结果页出现即证明 handleFinish 已经跑完
  await screen.findByText('答题结果');
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

describe('TargetedRunPage 完成发分', () => {
  beforeEach(() => {
    judgeMock.mockReset();
    completeMock.mockReset();
    explanationsMock.mockReset();
    getMyPointsMock.mockReset();
    generateMock.mockReset();
    judgeMock.mockResolvedValue(JUDGED);
    explanationsMock.mockResolvedValue({ explanations: {} });
    getMyPointsMock.mockResolvedValue(myPoints('铸铁'));
  });

  it('正常完成：用交接来的 sessionId 调 complete，并把发分结果 push 到 store', async () => {
    seed(77);
    completeMock.mockResolvedValue({
      pointsAwarded: 12,
      balance: 600,
      totalEarned: 600,
      levelUp: null,
    });

    await answerOnlyQuestion();

    await waitFor(() => {
      expect(completeMock).toHaveBeenCalledWith(77);
    });
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(usePointsStore.getState().queue).toHaveLength(1);
    expect(usePointsStore.getState().queue[0]).toMatchObject({
      points: 12,
      title: '数学专项 · 1 题',
    });
  });

  it('sessionId 为 null（会话 INSERT 降级）：不调 complete、不弹反馈、不报错', async () => {
    seed(null);

    await answerOnlyQuestion();

    expect(completeMock).not.toHaveBeenCalled();
    expect(usePointsStore.getState().queue).toHaveLength(0);
    // 学习流程照走：结果页正常渲染
    expect(screen.getByText('答题结果')).toBeTruthy();
  });

  it('balance 为 null（award_failed）：提示稍后到账 + 重试，不 push 假分；点重试再调一次 complete', async () => {
    seed(77);
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

    await answerOnlyQuestion();

    await screen.findByText('积分稍后到账，可重试');
    // 发分失败绝不污染本地积分快照
    expect(usePointsStore.getState().queue).toHaveLength(0);

    const retryButton = screen.getByRole('button', { name: '重试' });
    await act(async () => {
      fireEvent.click(retryButton);
    });

    expect(completeMock).toHaveBeenCalledTimes(2);
    // 重试期间按钮 loading、不可重复点
    const pending = screen.getByRole('button', { name: '重试中…' });
    expect(pending).toBeDisabled();

    await act(async () => {
      retry.resolve({ pointsAwarded: 12, balance: 600, totalEarned: 600, levelUp: null });
    });

    await waitFor(() => {
      expect(usePointsStore.getState().queue).toHaveLength(1);
    });
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 12, title: '数学专项 · 1 题' });
    expect(screen.queryByText('积分稍后到账，可重试')).toBeNull();
  });

  it('reason 为 already_completed（幂等命中，0 分）：静默，不 push 也不弹上限文案', async () => {
    seed(77);
    completeMock.mockResolvedValue({
      pointsAwarded: 0,
      balance: 600,
      totalEarned: 600,
      levelUp: null,
      reason: 'already_completed',
    });

    await answerOnlyQuestion();

    await waitFor(() => {
      expect(completeMock).toHaveBeenCalledWith(77);
    });
    expect(usePointsStore.getState().queue).toHaveLength(0);
    expect(screen.queryByText('积分稍后到账，可重试')).toBeNull();
  });

  it('段位晋升：全屏庆祝而不是轻反馈（不 push toast）', async () => {
    seed(77);
    completeMock.mockResolvedValue({
      pointsAwarded: 20,
      balance: 600,
      totalEarned: 600,
      levelUp: { from: 'pichai', to: 'zhutie' },
    });

    await answerOnlyQuestion();

    // 结果弹窗本身也是 role="dialog"，所以按可访问名精确锁定庆祝层
    expect(await screen.findByRole('dialog', { name: '晋升 铸铁！' })).toBeTruthy();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('判题时带上 sessionId（后端累加 judged_count 留痕）', async () => {
    seed(77);
    completeMock.mockResolvedValue({
      pointsAwarded: 0,
      balance: 600,
      totalEarned: 600,
      levelUp: null,
    });

    await answerOnlyQuestion();

    expect(judgeMock).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: 101, source: 'targeted', sessionId: 77 }),
    );
  });

  it('sessionId 为 null 时判题不带 sessionId 字段', async () => {
    seed(null);

    renderPage();
    fireEvent.click(screen.getAllByRole('radio')[1]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }));
    });
    await screen.findByText('答题结果');

    expect(judgeMock).toHaveBeenCalledTimes(1);
    expect(judgeMock.mock.calls[0][0]).not.toHaveProperty('sessionId');
  });

  /**
   * 错题补偿套题询问卡（2026-09-21 批）：专项结果页有答错题时才出现。
   * 这条同时钉住两件事：wrongCount 来自本轮真实结果、点击生成把 source/sessionId/wrongQuestionIds 原样送后端。
   */
  it('有答错题 → 渲染询问卡；点「生成练习」带上本轮错题号', async () => {
    seed(77);
    completeMock.mockResolvedValue({ pointsAwarded: 0, balance: 600, totalEarned: 600, levelUp: null });
    judgeMock.mockResolvedValue({ ...JUDGED, isCorrect: false });
    generateMock.mockResolvedValue({
      setId: 5, groupsCreated: 1, itemsCreated: 3, skippedNoKp: 0, aiPendingCount: 0,
    });

    await answerOnlyQuestion();

    expect(await screen.findByText(/本次错了 1 道题/)).toBeInTheDocument();
    // 槽位本身必须在（证明 testid 真的存在，不只是「找不到」恒真）
    expect(screen.getByTestId('remediation-offer-slot')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '生成练习' }));
    await waitFor(() =>
      expect(generateMock).toHaveBeenCalledWith({
        source: 'targeted', sessionId: 77, wrongQuestionIds: [101],
      }),
    );
  });

  it('全对 → 不渲染询问卡', async () => {
    seed(77);
    completeMock.mockResolvedValue({ pointsAwarded: 12, balance: 612, totalEarned: 612, levelUp: null });
    // judgeMock 默认 isCorrect: true

    await answerOnlyQuestion();

    expect(screen.queryByText(/本次错了/)).toBeNull();
    // 全对 → headerExtra 必须真正为 undefined（连空槽位 div 都不能留），
    // 否则 AnswerResultList 仍会画 border-b + 16px 空带（AnswerResultList.tsx:157-158）
    expect(screen.queryByTestId('remediation-offer-slot')).toBeNull();
  });
});
