import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import ExamResultPage from './ExamResultPage';
import {
  getExamResults,
  getExamSession,
  getMyPoints,
  getTrainingExplanations,
  selfAssessTraining,
  type ExamResultItem,
  type ExamSessionInfo,
  type ExamSummary,
  type MyPoints,
} from '@/services/api';
import { usePointsStore } from '@/store/pointsStore';

/**
 * 交卷结果页接发分反馈（计划 §3 Task 7c）。
 *
 * 交卷是**大任务**：发分走全屏 `task` 庆祝（不是轻反馈），且**分数与积分都要显示**。
 * 数据来源是 `ExamRunPage` 交卷后经 navigate state 交接过来的 `points` ——
 * 结果页自己的 `getExamResults` 是 GET，**不补发分**，所以：
 *   - 有 `points` → 庆祝，副标题里同时有分数与积分；
 *   - 没有 `points`（刷新 / 重复交卷 / 早退）→ 不弹任何积分反馈、也不报错；
 *   - `points.awarded === 0`（本次没加）→ 静默（交卷响应没有 reason 字段）。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 */
afterEach(() => {
  cleanup();
  usePointsStore.setState({ queue: [], revision: 0 });
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getExamSession: vi.fn(),
    getExamResults: vi.fn(),
    getTrainingExplanations: vi.fn(),
    selfAssessTraining: vi.fn(),
    waitTrainingExplanation: vi.fn(),
    getMyPoints: vi.fn(),
  };
});

const sessionMock = vi.mocked(getExamSession);
const resultsMock = vi.mocked(getExamResults);
const explanationsMock = vi.mocked(getTrainingExplanations);
const selfAssessMock = vi.mocked(selfAssessTraining);
const getMyPointsMock = vi.mocked(getMyPoints);

const ITEM: ExamResultItem = {
  questionId: 101,
  questionNo: 1,
  text: '1 + 1 = ?',
  type: 'choice',
  options: ['A. 1', 'B. 2'],
  answerText: 'B',
  isCorrect: 1,
  analysis: null,
  explanation: null,
  answer: 'B',
};

const SUMMARY: ExamSummary = { correctCount: 18, totalCount: 20, accuracy: 90 };

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

const SESSION: ExamSessionInfo = {
  sessionId: 77,
  status: 'submitted',
  remainingSeconds: 0,
  questions: [{ questionId: 101, questionNo: 1, text: '1 + 1 = ?', type: 'choice', options: ['A. 1', 'B. 2'] }],
};

/** 交卷页交接过来的导航 state（`points` 可选：刷新 / 重复交卷时没有）。 */
function renderResult(state?: unknown) {
  const router = createMemoryRouter(
    [{ path: '/student/training/exam/result/:sessionId', element: <ExamResultPage /> }],
    { initialEntries: [{ pathname: '/student/training/exam/result/77', state }] },
  );
  return render(<RouterProvider router={router} />);
}

describe('ExamResultPage 交卷发分庆祝', () => {
  beforeEach(() => {
    // 关掉烟花（reduce-motion 分支）——jsdom 没有 canvas 2D 实现
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    sessionMock.mockReset();
    resultsMock.mockReset();
    explanationsMock.mockReset();
    selfAssessMock.mockReset();
    getMyPointsMock.mockReset();
    sessionMock.mockResolvedValue(SESSION);
    resultsMock.mockResolvedValue({ ...SUMMARY, items: [ITEM] });
    explanationsMock.mockResolvedValue({ explanations: {} });
    getMyPointsMock.mockResolvedValue(myPoints('铸铁'));
  });

  it('awarded > 0 → 全屏 task 庆祝，副标题里同时有分数与积分；不弹轻反馈', async () => {
    renderResult({ points: { awarded: 12, balance: 612, levelUp: null } });

    const dialog = await screen.findByRole('dialog', { name: '本套试卷已交卷！' });
    expect(dialog).toBeTruthy();
    // 分数与积分都要显示（计划 §3 Task 7c）：分数来自页面已有的 summary
    const subtitle = screen.getByText(/客观题 18\/20/);
    expect(subtitle.textContent).toContain('90%');
    expect(subtitle.textContent).toContain('12');
    // 大任务只走全屏庆祝，不与轻反馈同弹
    expect(usePointsStore.getState().queue).toHaveLength(0);
    // 主按钮就地关闭（页面本身就是成绩页，不跳转）
    expect(screen.getByRole('button', { name: '查看成绩' })).toBeTruthy();
  });

  it('没有 points（刷新页面 / 重复交卷）→ 不弹任何积分反馈，也不报错', async () => {
    renderResult(undefined);

    // 页面本体照常渲染成绩（AnswerResultList 自身也是 role="dialog"，故按可访问名锁定庆祝层）
    expect(await screen.findByText('客观题答对')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '本套试卷已交卷！' })).toBeNull();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('points.awarded === 0（本次没加）→ 静默：不庆祝也不弹轻反馈', async () => {
    renderResult({ points: { awarded: 0, balance: 600, levelUp: null } });

    expect(await screen.findByText('客观题答对')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '本套试卷已交卷！' })).toBeNull();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('points.levelUp 非空 → 按既定优先级走 levelup 全屏（task 副标题被丢弃，分数仍在页面上）', async () => {
    renderResult({ points: { awarded: 12, balance: 612, levelUp: { from: 'pichai', to: 'zhutie' } } });

    expect(await screen.findByRole('dialog', { name: '晋升 铸铁！' })).toBeTruthy();
    // 已知取舍：levelup 不显示 task 的副标题，但分数仍在页面本体上可见
    expect(screen.queryByText(/客观题 18\/20/)).toBeNull();
    expect(screen.getByText('客观题答对')).toBeTruthy();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });
});
