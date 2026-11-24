import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
 *   - 有 `points` → 庆祝；副标题只写**分数**，积分由庆祝层自带的「+N 分」独占（Finding 2）；
 *   - `points.levelUp` 非空（交卷跨段位阈值）→ 走 levelup 全屏，但**仍带上这条分数副标题**，
 *     晋升不能把分数藏掉（Finding 1）；
 *   - 导航 state 里没有 `points`（重复交卷 / 已交卷分支 / 从考试列表重新进入）→
 *     不弹任何积分反馈、也不报错；
 *   - `points.awarded === 0`（本次没加）→ 静默（交卷响应的 `points` 没有 reason 字段）。
 *
 * 「只庆祝一次」（Finding 1）：react-router 的 state 存在 `history.state.usr` 上，浏览器 F5
 * 会恢复它 → 页面 mount 后**先把 points 抓进本地 state，再把这条 history entry 的 state
 * 剥成 null**。所以首次进入照常庆祝，刷新 / 前进后退恢复到的 entry 已无 points → 不再庆祝。
 * 两条用例分别钉住这两半：带 state 首进看到庆祝；剥掉后重挂载（等价刷新恢复）看不到。
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
  materialText: null,
  materialUrl: null,
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
  questions: [{ questionId: 101, questionNo: 1, text: '1 + 1 = ?', type: 'choice', options: ['A. 1', 'B. 2'], materialText: null, materialUrl: null }],
};

/** 建真 data router（`RunExitGuard` 依赖 data router，因此不能用 `MemoryRouter`）。 */
function makeResultRouter(state?: unknown) {
  return createMemoryRouter(
    [{ path: '/student/training/exam/result/:sessionId', element: <ExamResultPage /> }],
    { initialEntries: [{ pathname: '/student/training/exam/result/77', state }] },
  );
}

/**
 * 渲染结果页。返回 `router` 便于断言这条 history entry 的 state 是否已被剥掉
 * （「只庆祝一次」的实现细节，见文件头）。
 */
function renderResult(state?: unknown) {
  const router = makeResultRouter(state);
  return { router, ...render(<RouterProvider router={router} />) };
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

  it('awarded > 0 → 全屏 task 庆祝；副标题只写分数，积分由庆祝层的「+N 分」独占且只出现一次', async () => {
    renderResult({ points: { awarded: 12, balance: 612, levelUp: null } });

    const dialog = await screen.findByRole('dialog', { name: '本套试卷已交卷！' });
    expect(dialog).toBeTruthy();
    // 分数在页面副标题里（分数与积分都要显示：积分由庆祝层那一行负责）
    const subtitle = screen.getByText(/客观题 18\/20/);
    expect(subtitle.textContent).toContain('90%');
    expect(subtitle.textContent).not.toContain('积分');
    expect(subtitle.textContent).not.toContain('12');
    // 积分只渲染一次（Finding 2：副标题不再重复拼一遍）
    expect(screen.getAllByText('+12 分')).toHaveLength(1);
    // 大任务只走全屏庆祝，不与轻反馈同弹
    expect(usePointsStore.getState().queue).toHaveLength(0);
    // 主按钮就地关闭（页面本身就是成绩页，不跳转）
    expect(screen.getByRole('button', { name: '查看成绩' })).toBeTruthy();
  });

  it('交卷 state 只消费一次：庆祝后即从 history entry 剥掉；重挂载（等价刷新恢复）不再庆祝', async () => {
    const { router, unmount } = renderResult({ points: { awarded: 12, balance: 612, levelUp: null } });

    // 第一半：真交卷首进 → 照常庆祝
    expect(await screen.findByRole('dialog', { name: '本套试卷已交卷！' })).toBeTruthy();

    // 关键实现：mount 后把 points 从这条 history entry 剥掉（浏览器刷新恢复的正是它）
    await waitFor(() => expect(router.state.location.state).toBeNull());

    // 第二半：同一条 entry 重挂载 = F5 / 前进后退恢复 → 不再庆祝
    unmount();
    render(<RouterProvider router={router} />);
    expect(await screen.findByText('客观题答对')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '本套试卷已交卷！' })).toBeNull();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('导航 state 里没有 points（重复交卷 / 重新进入结果页）→ 不弹任何积分反馈，也不报错', async () => {
    renderResult(undefined);

    // 页面本体照常渲染成绩（AnswerResultList 自身也是 role="dialog"，故按可访问名锁定庆祝层）
    expect(await screen.findByText('客观题答对')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '本套试卷已交卷！' })).toBeNull();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('导航 state 只有无关键（不含 points）→ 不庆祝，也不把这条 state 清掉（清除范围收窄到 points）', async () => {
    const { router } = renderResult({ from: 'somewhere-else' });

    expect(await screen.findByText('客观题答对')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '本套试卷已交卷！' })).toBeNull();
    expect(usePointsStore.getState().queue).toHaveLength(0);
    // 本页只拥有 `points` 这一个 state 契约，别的 state 不该被顺手 wipe 掉
    expect(router.state.location.state).toEqual({ from: 'somewhere-else' });
  });

  it('points.awarded === 0（本次没加）→ 静默：不庆祝也不弹轻反馈', async () => {
    renderResult({ points: { awarded: 0, balance: 600, levelUp: null } });

    expect(await screen.findByText('客观题答对')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '本套试卷已交卷！' })).toBeNull();
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('points.levelUp 非空 → 走 levelup 全屏，但仍带上交卷副标题（分数与积分都要显示），且不弹轻反馈', async () => {
    renderResult({ points: { awarded: 12, balance: 612, levelUp: { from: 'pichai', to: 'zhutie' } } });

    expect(await screen.findByRole('dialog', { name: '晋升 铸铁！' })).toBeTruthy();
    // 交卷同时晋升（跨阈值）时，分数不能被晋升庆祝吞掉（Finding 1）
    const subtitle = screen.getByText(/客观题 18\/20/);
    expect(subtitle.textContent).toContain('90%');
    expect(screen.getByText('客观题答对')).toBeTruthy();
    // 积分仍由庆祝层那一行独占，只出现一次
    expect(screen.getAllByText('+12 分')).toHaveLength(1);
    // 晋升仍是全屏独占：该分支不 push 轻反馈
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  /**
   * 无参考答案（method='no_standard_answer'）：英语 974 卷 35 题全部无答案。
   * 这些题 isCorrect 也是 null，但**不能**被当成待自评：横幅不数、列表不给自评按钮。
   */
  it('无参考答案题不计入未自评横幅、不渲染自评按钮，普通客观题仍正常', async () => {
    const subjective: ExamResultItem = {
      ...ITEM, questionId: 102, questionNo: 2, type: 'short_answer', options: null,
      isCorrect: null, needsSelfAssessment: true, selfAssessment: null,
      answerText: '我的作答', answer: '参考答案',
    };
    const unscored = (id: number, n: number, answerText: string | null): ExamResultItem => ({
      ...ITEM, questionId: id, questionNo: n, type: 'short_answer', options: null,
      isCorrect: null, method: 'no_standard_answer', hasStandardAnswer: false,
      needsSelfAssessment: false, selfAssessment: null, answerText, answer: null,
    });
    resultsMock.mockResolvedValue({
      ...SUMMARY, correctCount: 1, totalCount: 1, accuracy: 100, unscoredCount: 2,
      items: [ITEM, subjective, unscored(103, 3, '我的作文'), unscored(104, 4, null)],
    });

    renderResult();

    // 两道无答案题各显示一次
    expect(await screen.findAllByText('无参考答案 · 不计分')).toHaveLength(2);
    // 无答案题不数进横幅：只有 1 道真正待自评的主观题
    expect(screen.getByText(/还有 1 题未自评/)).toBeTruthy();
    // 自评按钮只属于那道主观题（两道无答案题没有）
    expect(screen.getAllByRole('button', { name: '我做对了' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '我做错了' })).toHaveLength(1);
    // 客观题照常显示、照常计入
    expect(screen.getByTestId('result-qno-1')).toBeTruthy();
    expect(screen.getByText(/对\s*1/)).toBeTruthy();
  });

  /**
   * 跳题（method='unanswered'）不是「无参考答案」：后端照样判错、有标准答案、能看解析。
   * 回归钉子：映射曾把 method 原样透传，AnswerResultList 按 `method==='unanswered'`
   * 当成「该题暂无标准答案」，把跳题从错误计数剔除且隐藏了解析。
   */
  it('跳题（method=unanswered, isCorrect=0）仍按错题展示、能看解析、计入「错」，不显示「该题暂无标准答案」', async () => {
    const skipped: ExamResultItem = {
      ...ITEM, questionNo: 2, answerText: null, isCorrect: 0, method: 'unanswered',
      needsSelfAssessment: false, selfAssessment: null, explanation: '这题选 B',
    };
    resultsMock.mockResolvedValue({
      ...SUMMARY, correctCount: 1, totalCount: 2, accuracy: 50, items: [ITEM, skipped],
    });

    renderResult();

    expect(await screen.findByText(/错\s*1/)).toBeTruthy();
    expect(screen.getByText('（未作答）')).toBeTruthy();
    expect(screen.queryByText(/该题暂无标准答案/)).toBeNull();
    expect(screen.queryByText(/无参考答案/)).toBeNull();
    // 跳题不是主观题：不能进「主观」计数
    expect(screen.queryByText(/主观\s*\d/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看解析' }));
    expect(screen.getByText('这题选 B')).toBeTruthy();
  });

  /**
   * 重进结果页：后端 needsSelfAssessment 只看 method，已自评的主观题仍会带 true；
   * 前端必须以 selfAssessment 已有值为准，不能再给一次自评按钮。
   */
  it('重进已自评页：不渲染自评按钮，显示「已自评」', async () => {
    const assessed: ExamResultItem = {
      ...ITEM, questionId: 102, questionNo: 2, type: 'short_answer', options: null,
      isCorrect: null, method: 'self_assess', needsSelfAssessment: true,
      selfAssessment: 'correct', answerText: '我的作答', answer: '参考答案',
    };
    resultsMock.mockResolvedValue({
      ...SUMMARY, correctCount: 1, totalCount: 2, accuracy: 50, subjectiveCount: 1,
      items: [ITEM, assessed],
    });

    renderResult();

    expect(await screen.findByText(/已自评：做对了/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '我做对了' })).toBeNull();
    expect(screen.queryByRole('button', { name: '我做错了' })).toBeNull();
    // 已自评 → 不再计入未自评横幅
    expect(screen.queryByText(/还有 \d+ 题未自评/)).toBeNull();
  });

  /**
   * 全卷无参考答案（974 卷形状，32 道在架无答案）：没有可计分题。
   * 顶部不能出现「客观题 0/0 · 正确率 0%」这种像考砸了的读数，改为中性文案。
   */
  it('全卷无答案：显示「本次无可计分题」+「无参考答案 32 题」；不出现正确率 0%', async () => {
    const unscored = (n: number): ExamResultItem => ({
      ...ITEM, questionId: 300 + n, questionNo: n, type: 'short_answer', options: null,
      isCorrect: null, method: 'no_standard_answer', hasStandardAnswer: false,
      needsSelfAssessment: false, selfAssessment: null, answerText: `作答 ${n}`, answer: null,
    });
    resultsMock.mockResolvedValue({
      correctCount: 0, totalCount: 0, accuracy: 0, unscoredCount: 32,
      items: Array.from({ length: 32 }, (_, i) => unscored(i + 1)),
    });

    renderResult();

    expect(await screen.findByText('本次无可计分题')).toBeTruthy();
    expect(screen.getByText('无参考答案 32 题 · 不计分')).toBeTruthy();
    // AnswerResultList 顶部统计也单列无参考答案题数
    expect(screen.getByText('无参考答案 32 题')).toBeTruthy();
    expect(screen.queryByText(/正确率 0%/)).toBeNull();
    expect(screen.queryByText('客观题答对')).toBeNull();
  });

  it('全卷无答案 + 有交卷积分：庆祝副标题同样走「本次无可计分题」分支', async () => {
    const unscored: ExamResultItem = {
      ...ITEM, type: 'short_answer', options: null, isCorrect: null,
      method: 'no_standard_answer', hasStandardAnswer: false,
      needsSelfAssessment: false, selfAssessment: null, answerText: '作答', answer: null,
    };
    resultsMock.mockResolvedValue({
      correctCount: 0, totalCount: 0, accuracy: 0, unscoredCount: 32, items: [unscored],
    });

    renderResult({ points: { awarded: 12, balance: 612, levelUp: null } });

    expect(await screen.findByRole('dialog', { name: '本套试卷已交卷！' })).toBeTruthy();
    expect(screen.getByText(/本次无可计分题 · 无参考答案 32 题/)).toBeTruthy();
    expect(screen.queryByText(/正确率 0%/)).toBeNull();
  });

  /**
   * 错题补偿套题询问卡（2026-09-21 批）：结果页有客观错题时才出现。
   * 一正一反两条：只断言「出现」证明不了 wrongCount 是从 items 算的——还得证明没错题时不出现。
   */
  it('有客观错题 → 渲染补偿套题询问卡，且错题数与 items 一致', async () => {
    const wrong = (n: number): ExamResultItem => ({ ...ITEM, questionId: 200 + n, questionNo: n, isCorrect: 0 });
    resultsMock.mockResolvedValue({ ...SUMMARY, items: [ITEM, wrong(2), wrong(3)] });

    renderResult();

    expect(await screen.findByText(/本次错了 2 道题/)).toBeInTheDocument();
    // 槽位本身必须在（证明 testid 真的存在，不只是「找不到」恒真）
    expect(screen.getByTestId('remediation-offer-slot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成练习' })).toBeInTheDocument();
  });

  it('无客观错题（含只有主观题待自评）→ 不渲染询问卡', async () => {
    // ITEM.isCorrect = 1；再加一道 isCorrect: null 的主观题（自评口径的「错」不该算进来）
    resultsMock.mockResolvedValue({
      ...SUMMARY,
      items: [ITEM, { ...ITEM, questionId: 202, questionNo: 2, type: 'short_answer', isCorrect: null }],
    });

    renderResult();

    await screen.findByText('答题结果'); // 等页面加载完（AnswerResultList 既有标题）
    expect(screen.queryByText(/本次错了/)).toBeNull();
    // 无客观错题 → 槽位必须整块不渲染（不是渲染空 div），否则分数卡下方会多出 16px 空白条
    expect(screen.queryByTestId('remediation-offer-slot')).toBeNull();
  });
});


describe('ExamResultPage 同题号小问不串数据', () => {
  beforeEach(() => {
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
    explanationsMock.mockResolvedValue({ explanations: {} });
    getMyPointsMock.mockResolvedValue(myPoints('铸铁'));
    selfAssessMock.mockResolvedValue({ saved: true } as never);
  });

  it('两小问各自显示自己的解析', async () => {
    const wrong = (id: number, sub: number, explanation: string): ExamResultItem => ({
      ...ITEM, questionId: id, questionNo: 26, subNo: sub,
      text: `(${sub}) 题`, isCorrect: 0, explanation, answer: 'B',
    });
    resultsMock.mockResolvedValue({
      ...SUMMARY, correctCount: 0, totalCount: 2, accuracy: 0,
      items: [wrong(201, 1, '解析甲'), wrong(202, 2, '解析乙')],
    });

    renderResult();
    const buttons = await screen.findAllByRole('button', { name: '查看解析' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    expect(screen.getByText('解析甲')).toBeTruthy();
    expect(screen.queryByText('解析乙')).toBeNull();
    fireEvent.click(buttons[1]);
    expect(screen.getByText('解析乙')).toBeTruthy();
    expect(screen.queryByText('解析甲')).toBeNull();
  });

  it('两小问各自显示参考答案，自评只改被点的那一问', async () => {
    const subjective = (id: number, sub: number, answer: string): ExamResultItem => ({
      ...ITEM, questionId: id, questionNo: 26, subNo: sub,
      text: `(${sub}) 题`, type: 'short_answer', options: null,
      isCorrect: null, needsSelfAssessment: true, selfAssessment: null,
      answerText: '我的作答', answer,
    });
    resultsMock.mockResolvedValue({
      ...SUMMARY, items: [subjective(201, 1, '参考答案甲'), subjective(202, 2, '参考答案乙')],
    });

    renderResult();
    const explainButtons = await screen.findAllByRole('button', { name: '查看解析' });
    fireEvent.click(explainButtons[0]);
    expect(screen.getByText('参考答案甲')).toBeTruthy();
    expect(screen.queryByText('参考答案乙')).toBeNull();

    const agreeButtons = screen.getAllByRole('button', { name: '我做对了' });
    expect(agreeButtons).toHaveLength(2);
    fireEvent.click(agreeButtons[0]);
    await waitFor(() => expect(selfAssessMock).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: 201, assessment: 'correct' }),
    ));
    await waitFor(() => expect(screen.getByText(/已自评：做对了/)).toBeTruthy());
    expect(screen.getAllByRole('button', { name: '我做对了' })).toHaveLength(1);
  });
});
