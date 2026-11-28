import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import TargetedRunPage from './TargetedRunPage';
import {
  completeSpecialSession,
  completeTrainingSession,
  generateRemediationSet,
  getMyPoints,
  getTrainingExplanations,
  judgeTraining,
  recommendFeaturedSet,
  selfAssessTraining,
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
    completeSpecialSession: vi.fn(),
    getMyPoints: vi.fn(),
    generateRemediationSet: vi.fn(),
    recommendFeaturedSet: vi.fn(),
    selfAssessTraining: vi.fn(),
  };
});

const judgeMock = vi.mocked(judgeTraining);
const completeMock = vi.mocked(completeTrainingSession);
const completeSpecialMock = vi.mocked(completeSpecialSession);
const explanationsMock = vi.mocked(getTrainingExplanations);
const getMyPointsMock = vi.mocked(getMyPoints);
const generateMock = vi.mocked(generateRemediationSet);
const recommendMock = vi.mocked(recommendFeaturedSet);
const selfAssessMock = vi.mocked(selfAssessTraining);

const KEY = 'training:targeted';

const QUESTION: TargetedPracticeQuestion = {
  questionId: 101,
  text: '1 + 1 = ?',
  type: 'choice',
  options: ['A. 1', 'B. 2'],
  materialText: null,
  materialUrl: null,
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

/** featured 精选题单交接体：sessionId 恒 null（不发分），sessionUid 来自服务端 open。 */
function seedFeatured(sessionUid: string) {
  sessionStorage.setItem(KEY, JSON.stringify({
    sessionId: null, questions: [QUESTION], title: '精选数学', mode: 'featured', sessionUid,
  }));
}

/** RunExitGuard 用 useBlocker —— 必须是 data router（createMemoryRouter）。
 *  第二条路由是结果页「确认」离开后的落点，用来断言导航真的发生了。 */
function renderPage(url = '/') {
  const router = createMemoryRouter(
    [
      { path: '/', element: <TargetedRunPage /> },
      { path: '/student/training/targeted', element: <div>已回到配置页</div> },
      { path: '/student/practice-history/exam/9', element: <div>已回到详情页</div> },
      { path: '/student/featured-sets', element: <div>已回到精选题单</div> },
    ],
    { initialEntries: [url] },
  );
  return render(<RouterProvider router={router} />);
}

/** 答完唯一一题（点选 B）并提交 → QuestionRunner 收尾 → handleFinish。 */
async function answerOnlyQuestion(url = '/') {
  renderPage(url);
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

describe('专项作答页题目来源', () => {
  it('题单带 source + questionNo 时展示「来源：… · 试卷第 N 题」，便于溯源', async () => {
    sessionStorage.setItem(KEY, JSON.stringify({
      sessionId: 1,
      questions: [{ ...QUESTION, source: '2025 海淀 初三（上）期中', questionNo: 12 }],
    }));
    renderPage();
    const source = await screen.findByTestId('question-source');
    expect(source).toHaveTextContent('来源：2025 海淀 初三（上）期中 · 试卷第 12 题');
  });

  it('题目无卷关联时只展示来源，不补位次', async () => {
    sessionStorage.setItem(KEY, JSON.stringify({
      sessionId: 1,
      questions: [{ ...QUESTION, source: 'freeform', questionNo: null }],
    }));
    renderPage();
    const source = await screen.findByTestId('question-source');
    expect(source).toHaveTextContent('来源：答疑录入');
    expect(source).not.toHaveTextContent('试卷第');
  });
});

describe('TargetedRunPage 完成发分', () => {
  beforeEach(() => {
    judgeMock.mockReset();
    completeMock.mockReset();
    completeSpecialMock.mockReset();
    explanationsMock.mockReset();
    getMyPointsMock.mockReset();
    generateMock.mockReset();
    recommendMock.mockReset();
    selfAssessMock.mockReset();
    judgeMock.mockResolvedValue(JUDGED);
    explanationsMock.mockResolvedValue({ explanations: {}, approaches: {} });
    getMyPointsMock.mockResolvedValue(myPoints('铸铁'));
    completeSpecialMock.mockResolvedValue({ completed: true });
    recommendMock.mockResolvedValue({ setId: 3, alreadyRecommended: false });
    selfAssessMock.mockResolvedValue({});
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

  /**
   * 2026-11-28 用户实测：末题提交后一直停在「判题中」。
   * 根因不是判题——判题早已返回；是 `handleFinish` 把批量拉解析 `await` 在 `setPhase('result')`
   * 之前，当时后端该端点还会等 in-flight 解析生成（60s 兜底；现已改纯读库）。
   * 钉住：前端不得再让解析请求挡住结果页——请求未返回（甚至永不返回）也必须先渲染结果。
   */
  it('解析请求未返回 → 结果页立即可见，不卡在「判题中」', async () => {
    seed(77);
    completeMock.mockResolvedValue({ pointsAwarded: 0, balance: 600, totalEarned: 600, levelUp: null });
    judgeMock.mockResolvedValue({ ...JUDGED, isCorrect: false });
    // 永不 resolve：模拟请求挂住（网络慢 / 后端异常）
    explanationsMock.mockReturnValue(new Promise(() => {}));

    await answerOnlyQuestion();

    expect(screen.getByText('答题结果')).toBeInTheDocument();
    expect(screen.queryByText('判题中，请稍候…')).toBeNull();
  });

  it('批量返回思路与解析后，展开解析先显示思路再显示详解', async () => {
    seed(77);
    completeMock.mockResolvedValue({ pointsAwarded: 0, balance: 600, totalEarned: 600, levelUp: null });
    judgeMock.mockResolvedValue({ ...JUDGED, isCorrect: false });
    explanationsMock.mockResolvedValue({
      explanations: { 101: '详细过程' },
      approaches: { 101: '先分析等量关系' },
    });

    await answerOnlyQuestion();
    await userEvent.click(await screen.findByRole('button', { name: '查看解析' }));

    const approach = screen.getByTestId('result-approach-101');
    const explanation = screen.getByTestId('result-explanation-101');
    expect(approach).toHaveTextContent('先分析等量关系');
    expect(explanation).toHaveTextContent('详细过程');
    expect(approach.compareDocumentPosition(explanation) & 4).toBe(4);
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
      expect.objectContaining({
        questionId: 101, source: 'targeted', sessionId: 77,
        // 作答历史（2026-11-01）：必须带 sessionUid，否则专项作答永不落库、练习记录看不到
        sessionUid: expect.any(String),
        questionCount: expect.any(Number),
        questionOrder: expect.any(Number),
      }),
    );
    expect((judgeMock.mock.calls[0][0] as { sessionUid: string }).sessionUid.length).toBeGreaterThan(0);
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
   * 练习记录入口的 `returnTo`：只在白名单内回详情页，其它值（手改 URL / 外链）
   * 必须退回专项配置页——否则学生会被导航到一个非本站路径。
   */
  it('returnTo 指向练习记录详情：结果页「确认」回详情页', async () => {
    seed(77);
    completeMock.mockResolvedValue({ pointsAwarded: 0, balance: 600, totalEarned: 600, levelUp: null });

    await answerOnlyQuestion(`/?subjectId=1&returnTo=${encodeURIComponent('/student/practice-history/exam/9')}`);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认' }));
    });

    expect(await screen.findByText('已回到详情页')).toBeTruthy();
  });

  it('featured 的 returnTo 指向精选题单：结果页「确认」回精选题单 Tab', async () => {
    seed(77);
    completeMock.mockResolvedValue({ pointsAwarded: 0, balance: 600, totalEarned: 600, levelUp: null });

    await answerOnlyQuestion(`/?subjectId=1&returnTo=${encodeURIComponent('/student/featured-sets')}`);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认' }));
    });

    expect(await screen.findByText('已回到精选题单')).toBeTruthy();
  });

  it('returnTo 不在白名单：忽略并退回配置页', async () => {
    seed(77);
    completeMock.mockResolvedValue({ pointsAwarded: 0, balance: 600, totalEarned: 600, levelUp: null });

    await answerOnlyQuestion(`/?subjectId=1&returnTo=${encodeURIComponent('https://evil.example/x')}`);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认' }));
    });

    expect(await screen.findByText('已回到配置页')).toBeTruthy();
  });

  it('returnTo 是穿越路径（形状不符）：忽略并退回配置页', async () => {
    seed(77);
    completeMock.mockResolvedValue({ pointsAwarded: 0, balance: 600, totalEarned: 600, levelUp: null });

    await answerOnlyQuestion(
      `/?subjectId=1&returnTo=${encodeURIComponent('/student/practice-history/../../admin/x')}`,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认' }));
    });

    expect(await screen.findByText('已回到配置页')).toBeTruthy();
  });

  /**
   * 练习记录复用本页（2026-11-06 Task 9）：同一页跑两种模式。
   * - redo：单题、不计时不发分 → 不带 sessionId/sessionUid/plannedQuestionIds，只带 suppressErrorFixPoints；
   * - similar：走原有会话发分链路，额外带 plannedQuestionIds（答题历史的题单快照）。
   * 两种模式都必须送**真实 1-based 题号**（旧实现误把 questionId 当题号）。
   */
  it('redo 模式：judge 带 suppressErrorFixPoints，不带 sessionUid/sessionId/plannedQuestionIds', async () => {
    sessionStorage.setItem(KEY, JSON.stringify({
      sessionId: null, questions: [QUESTION], mode: 'redo', title: '重做：卷 · 第 1 题',
    }));
    judgeMock.mockResolvedValue(JUDGED);
    await answerOnlyQuestion();
    expect(judgeMock).toHaveBeenCalledWith(expect.objectContaining({
      suppressErrorFixPoints: true,
      questionOrder: 1,
    }));
    const arg = judgeMock.mock.calls[0][0];
    expect(arg.sessionId).toBeUndefined();
    expect(arg.sessionUid).toBeUndefined();
    expect(arg.plannedQuestionIds).toBeUndefined();
  });

  it('similar 模式：judge 带 plannedQuestionIds 与真实题号', async () => {
    seed(88);
    judgeMock.mockResolvedValue(JUDGED);
    await answerOnlyQuestion();
    expect(judgeMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 88, plannedQuestionIds: [101], questionOrder: 1,
    }));
    expect(typeof judgeMock.mock.calls[0][0].sessionUid).toBe('string');
  });

  /**
   * 题号必须是题单里的 1-based 位置，不是常量 1：只测单题的话，写死 `questionOrder: 1`
   * 也能过。两题题单里答第二题必须送 2（旧实现误把 questionId / 常量当题号）。
   */
  it('两题题单：第二题送 questionOrder 2（1..N，不是常量）', async () => {
    sessionStorage.setItem(KEY, JSON.stringify({
      sessionId: 88,
      questions: [QUESTION, { ...QUESTION, questionId: 205, text: '2 + 2 = ?' }],
    }));
    judgeMock.mockResolvedValue(JUDGED);

    renderPage();
    fireEvent.click(screen.getAllByRole('radio')[1]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }));
    });

    // 第一题提交后切到第二题
    await screen.findByText('2 + 2 = ?');
    fireEvent.click(screen.getAllByRole('radio')[1]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }));
    });

    await screen.findByText('答题结果');

    expect(judgeMock).toHaveBeenCalledTimes(2);
    expect(judgeMock.mock.calls[0][0]).toMatchObject({ questionId: 101, questionOrder: 1 });
    expect(judgeMock.mock.calls[1][0]).toMatchObject({ questionId: 205, questionOrder: 2 });
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

  /**
   * 补偿入口按学科配置放行（只有数学 supportsRemediation=true）：
   * 英语同样有答错题、会话也正常建了，但既不能画询问卡、连槽位都不能留。
   */
  it('英语（subjectId=3）判错后仍不显示相似题补偿入口', async () => {
    seed(77);
    completeMock.mockResolvedValue({ pointsAwarded: 0, balance: 600, totalEarned: 600, levelUp: null });
    judgeMock.mockResolvedValue({ ...JUDGED, isCorrect: false });

    await answerOnlyQuestion('/?subjectId=3');

    expect(await screen.findByText('答题结果')).toBeInTheDocument();
    expect(screen.queryByTestId('remediation-offer-slot')).toBeNull();
    expect(screen.queryByText(/本次错了/)).toBeNull();
    expect(screen.queryByRole('button', { name: '生成练习' })).toBeNull();
  });

  /**
   * 会话结束后的守卫回归钉子（2026-09-22 用户报障）：
   * 答完最后一题后点结果页「确认」= 正常结束、回配置页，**不得**再弹
   * 「确认离开 / 继续答题」—— 那是「还没答完就想走」的确认，题都答完了就不该出现。
   * 曾因 handleFinish 没把 guardRef.current 置 false，末题答完（1/3/5 题一样）点确认必弹。
   */
  it('答完最后一题后点结果页「确认」：直接离开，不弹退出守卫', async () => {
    seed(77);
    completeMock.mockResolvedValue({
      pointsAwarded: 12,
      balance: 612,
      totalEarned: 612,
      levelUp: null,
    });

    await answerOnlyQuestion();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认' }));
    });

    // 会话已结束：守卫必须放行，RunExitGuard 的两个按钮都不该出现
    expect(screen.queryByRole('button', { name: '确认离开' })).toBeNull();
    expect(screen.queryByRole('button', { name: '继续答题' })).toBeNull();
    // 且确实导航离开了答题页
    expect(await screen.findByText('已回到配置页')).toBeTruthy();
  });

  /**
   * Task 10（2026-11-26）：专项会话完成端点让「只判了没自评完」的会话也能收尾。
   * 用与 judge 相同的 sessionUid；redo 不建会话，故不得调用。
   */
  it('完成时调 completeSpecialSession，且用的是判题那条会话的 uid', async () => {
    seed(77);
    completeMock.mockResolvedValue({ pointsAwarded: 0, balance: 600, totalEarned: 600, levelUp: null });

    await answerOnlyQuestion();

    await waitFor(() => expect(completeSpecialMock).toHaveBeenCalledTimes(1));
    const uid = (judgeMock.mock.calls[0][0] as Record<string, unknown>).sessionUid;
    expect(completeSpecialMock).toHaveBeenCalledWith(uid);
  });

  it('redo 模式不调 completeSpecialSession（不建专项会话）', async () => {
    sessionStorage.setItem(KEY, JSON.stringify({
      sessionId: null, questions: [QUESTION], mode: 'redo', title: '重做：卷 · 第 1 题',
    }));

    await answerOnlyQuestion();

    expect(completeSpecialMock).not.toHaveBeenCalled();
  });
});

/**
 * 精选题单 featured 模式（2026-11-28 Task 10）：复用专项运行器，但三处硬约束：
 * 1. sessionUid 用服务端 open 端点生成并随交接体带来的那个，页面不得重新生成；
 * 2. sessionId 恒 null → 积分 hook 自动跳过，结果页没有任何积分/庆祝反馈；
 * 3. 判题/自评带 suppressErrorFixPoints（真实保证在服务端 session，见 Task 7）。
 */
describe('TargetedRunPage featured 模式', () => {
  beforeEach(() => {
    judgeMock.mockReset();
    completeMock.mockReset();
    completeSpecialMock.mockReset();
    explanationsMock.mockReset();
    recommendMock.mockReset();
    selfAssessMock.mockReset();
    judgeMock.mockResolvedValue(JUDGED);
    explanationsMock.mockResolvedValue({ explanations: {}, approaches: {} });
    completeSpecialMock.mockResolvedValue({ completed: true });
    recommendMock.mockResolvedValue({ setId: 3, alreadyRecommended: false });
    selfAssessMock.mockResolvedValue({});
  });

  it('featured 完成后只调 completeSpecialSession（服务端 uid），不调积分完成', async () => {
    seedFeatured('server-uid-1');

    await answerOnlyQuestion();

    await waitFor(() => expect(completeSpecialMock).toHaveBeenCalledWith('server-uid-1'));
    expect(completeSpecialMock).toHaveBeenCalledTimes(1);
    expect(completeMock).not.toHaveBeenCalled();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('featured 判题用服务端 sessionUid、带 suppressErrorFixPoints，且不带 sessionId', async () => {
    seedFeatured('server-uid-2');

    await answerOnlyQuestion();

    expect(judgeMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionUid: 'server-uid-2',
      suppressErrorFixPoints: true,
      title: '精选数学',
      questionCount: 1,
      plannedQuestionIds: [101],
      questionOrder: 1,
    }));
    expect(judgeMock.mock.calls[0][0]).not.toHaveProperty('sessionId');
  });

  it('featured 结果页不渲染积分反馈', async () => {
    seedFeatured('server-uid-3');

    await answerOnlyQuestion();

    // brief 指定的断言（当前 CelebrationOverlay 根节点没有这个 testid，保留作契约占位）
    expect(screen.queryByTestId('celebration-overlay')).toBeNull();
    // 真正的强度来自下列断言：庆祝层三种图标都不在、无积分提示条、store 无入账
    expect(screen.queryByTestId('celebration-glow')).toBeNull();
    expect(screen.queryByTestId('celebration-level-icon')).toBeNull();
    expect(screen.queryByTestId('celebration-task-icon')).toBeNull();
    expect(screen.queryByText('积分稍后到账，可重试')).toBeNull();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('featured 主观题自评带服务端 uid 与 suppressErrorFixPoints', async () => {
    sessionStorage.setItem(KEY, JSON.stringify({
      sessionId: null, questions: [{ ...QUESTION, questionId: 102, text: '证明题', type: 'proof' }],
      title: '精选数学', mode: 'featured', sessionUid: 'server-uid-4',
    }));
    judgeMock.mockResolvedValue({
      questionId: 102, isCorrect: null, method: 'self_assess',
      needsSelfAssessment: true, pointsAwarded: 0,
    });

    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByRole('textbox'), '我的证明');
    await user.click(screen.getByRole('button', { name: '提交' }));
    expect(await screen.findByRole('button', { name: '我做对了' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '我做对了' }));
    await screen.findByText('答题结果');

    expect(selfAssessMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionUid: 'server-uid-4',
      suppressErrorFixPoints: true,
      questionId: 102,
      source: 'targeted',
    }));
  });

  /**
   * 结果页推荐按钮（Task 10 Step 6）：正常专项 / featured / redo 都能推荐，
   * 推荐的是当前结果页里的实际题目集合（不是写死的 id）。
   */
  it.each([
    ['正常专项', () => seed(77)],
    ['featured', () => seedFeatured('server-uid-5')],
    ['redo', () => sessionStorage.setItem(KEY, JSON.stringify({
      sessionId: null, questions: [QUESTION], mode: 'redo', title: '重做：卷 · 第 1 题',
    }))],
  ])('结果页推荐按钮（%s）带当前题单 questionId', async (_label, setup) => {
    setup();
    completeMock.mockResolvedValue({ pointsAwarded: 0, balance: 600, totalEarned: 600, levelUp: null });

    await answerOnlyQuestion();

    const footer = screen.getByTestId('answer-result-footer');
    const recommend = within(footer).getByRole('button', { name: '推荐这套题' });
    expect(recommend.closest('[data-testid="recommend-featured-slot"]')).not.toBeNull();
    fireEvent.click(recommend);
    await waitFor(() => expect(recommendMock).toHaveBeenCalledWith([101]));
  });

  it('推荐按钮不占用答题结果标题下方槽位', async () => {
    seed(77);
    completeMock.mockResolvedValue({ pointsAwarded: 0, balance: 600, totalEarned: 600, levelUp: null });

    await answerOnlyQuestion();

    const slot = screen.getByTestId('recommend-featured-slot');
    expect(slot.closest('[data-testid="answer-result-footer"]')).not.toBeNull();
  });
});
