import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import PracticeHistoryDetailPage from './PracticeHistoryDetailPage';
import {
  getMyPointRules,
  getPracticeHistoryDetail,
  redoPractice,
  startSimilarPractice,
} from '@/services/api';
import { toast } from '@/components/base/Toast';

/**
 * 练习记录详情（2026-11-01）。
 * 契约：逐题回放（题面 + 我的答案 + 正确答案 + 解析 + 对错）；
 * 语文专项 questionId=null 时按 JSON 结构渲染；404 有回列表入口。
 *
 * 2026-11-06 追加：单题「重做」/「同类型练习」入口与「未作答」徽章。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getPracticeHistoryDetail: vi.fn(),
    getMyPointRules: vi.fn(),
    redoPractice: vi.fn(),
    startSimilarPractice: vi.fn(),
  };
});

// 只替换 toast 导出（本文件不渲染 ToastContainer）；其余导出保持真实模块，
// 否则 base/index 的 `export { ToastContainer } from './Toast'` 会缺导出而整体报错。
vi.mock('@/components/base/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base/Toast')>();
  return { ...actual, toast: vi.fn() };
});

const getDetailMock = vi.mocked(getPracticeHistoryDetail);
const getPointRulesMock = vi.mocked(getMyPointRules);
const redoMock = vi.mocked(redoPractice);
const startSimilarMock = vi.mocked(startSimilarPractice);
const toastMock = vi.mocked(toast);

const EXAM_SESSION = {
  source: 'exam' as const,
  sessionId: 1,
  subjectId: 4,
  title: '北师大物理实验卷',
  module: null,
  startedAt: '2026-11-01T06:00:00.000Z',
  completedAt: '2026-11-01T06:40:00.000Z',
  totalCount: 2,
  correctCount: 1,
};

const SPECIAL_SESSION = {
  source: 'special' as const,
  sessionId: 5,
  subjectId: 2,
  title: '默写专项·静夜思',
  module: 'chinese_dictation',
  startedAt: '2026-10-31T11:30:00.000Z',
  completedAt: '2026-10-31T11:35:00.000Z',
  totalCount: 1,
  correctCount: 0,
};

/** 未作答 + 可重做/可同类型（数学卷）。 */
const UNANSWERED_QUESTION = {
  questionId: 100, questionOrder: 1, answerText: null, isCorrect: null, score: null,
  method: 'unanswered', analysis: null, judgedAt: null, materialText: null,
  questionContent: '题干', questionAnswer: 'A', questionAnalysis: null,
  refType: 'question', refId: null, sentenceIndex: null,
  passageTitle: null, passageSentence: null,
  canRedo: true, canSimilar: true,
};

/** 数学专项 1/2/3/5 档（与 getMyPointRules 返回形状一致）。 */
const MATH_RULES = {
  tasks: [{
    taskCode: 'math_targeted',
    taskName: '数学专项',
    tiers: [
      { tierKey: '1', tierLabel: '1 题', points: 2, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
      { tierKey: '2', tierLabel: '2 题', points: 5, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
      { tierKey: '3', tierLabel: '3 题', points: 8, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
      { tierKey: '5', tierLabel: '5 题', points: 15, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
    ],
  }],
};

/** 语文专项只有 1/3/5 档（无 2 题档）。 */
const CN_RULES = {
  tasks: [{
    taskCode: 'cn_targeted',
    taskName: '语文专项',
    tiers: [
      { tierKey: '1', tierLabel: '1 题', points: 2, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
      { tierKey: '3', tierLabel: '3 题', points: 8, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
      { tierKey: '5', tierLabel: '5 题', points: 15, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
    ],
  }],
};

/** 答题页占位：把 pathname+search 打出来，用来断言跳转参数。 */
function RunStub() {
  const location = useLocation();
  return <div data-testid="run-stub">{`${location.pathname}${location.search}`}</div>;
}

const RETURN_TO = encodeURIComponent('/student/practice-history/exam/1');

function renderAt(source: string, sessionId: string) {
  return render(
    <MemoryRouter initialEntries={[`/student/practice-history/${source}/${sessionId}`]}>
      <Routes>
        <Route path="/student/practice-history/:source/:sessionId" element={<PracticeHistoryDetailPage />} />
        <Route path="/student/training/targeted/run" element={<RunStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 数学习题详情 + 规则（三个同类练习用例的公共前置）。 */
function mockMathDetailWithRules() {
  getDetailMock.mockResolvedValue({
    session: { ...EXAM_SESSION, subjectId: 1 },
    questions: [{ ...UNANSWERED_QUESTION }],
  });
  getPointRulesMock.mockResolvedValue(MATH_RULES);
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  // 默认不变更档位（只影响渲染了 canSimilar 的用例，逐个覆盖）
  getPointRulesMock.mockResolvedValue({ tasks: [] });
});

afterEach(() => cleanup());

describe('PracticeHistoryDetailPage', () => {
  it('加载中显示骨架', () => {
    getDetailMock.mockReturnValue(new Promise(() => {}));
    renderAt('exam', '1');
    expect(screen.getByTestId('history-detail-skeleton')).toBeInTheDocument();
  });

  it('考试详情：逐题渲染题面、我的答案、正确答案、对错', async () => {
    getDetailMock.mockResolvedValue({
      session: EXAM_SESSION,
      questions: [
        {
          questionId: 100, questionOrder: 1, answerText: 'B', isCorrect: false, score: 0,
          method: 'exact', analysis: '解析一', judgedAt: null,
          materialText: '阅读下面的材料，完成第1-3题。',
          questionContent: '第1题题面', questionAnswer: 'C', questionAnalysis: null,
          refType: 'question', refId: null, sentenceIndex: null,
          passageTitle: null, passageSentence: null,
          canRedo: false, canSimilar: false,
        },
        {
          questionId: 101, questionOrder: 2, answerText: 'A', isCorrect: true, score: 1,
          method: 'exact', analysis: null, judgedAt: null,
          materialText: null,
          questionContent: '第2题题面', questionAnswer: 'A', questionAnalysis: '题库解析二',
          refType: 'question', refId: null, sentenceIndex: null,
          passageTitle: null, passageSentence: null,
          canRedo: false, canSimilar: false,
        },
      ],
    });
    renderAt('exam', '1');
    await waitFor(() => expect(screen.getByText('北师大物理实验卷')).toBeInTheDocument());
    expect(screen.getByText('第1题题面')).toBeInTheDocument();
    expect(screen.getByText('第2题题面')).toBeInTheDocument();
    expect(screen.getByText('答错')).toBeInTheDocument();
    // 「答对」同时出现在状态徽章与页头统计
    expect(screen.getAllByText('答对').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('C')).toBeInTheDocument(); // 正确答案
    expect(screen.getByText('解析一')).toBeInTheDocument();
    expect(screen.getByText('题库解析二')).toBeInTheDocument();
    // 材料独立区块渲染（2026-11-02 用户要求：语文/英语阅读、物化题内材料）
    const material = screen.getByTestId('history-material');
    expect(material).toHaveTextContent('阅读下面的材料');
    // Markdown 正文容器：挂 md-prose 恢复标题/列表等语义排版（2026-11-07）
    expect(material.className).toContain('md-prose');
  });

  it('我的答案是裸 LaTeX 时补 $ 后渲染成公式（不再显示字面 \\frac）', async () => {
    // 2026-11-06 用户报告：exam/63 第 9 题作答存的是裸 \frac{1}{5}，
    // 结果页会自动补 $ 而这里没有，公式退化成文本。
    getDetailMock.mockResolvedValue({
      session: EXAM_SESSION,
      questions: [{
        questionId: 100, questionOrder: 1, answerText: '\\frac{1}{5}', isCorrect: true, score: 1,
        method: 'exact', analysis: null, judgedAt: null, materialText: null,
        questionContent: '题面', questionAnswer: '$\\dfrac15$', questionAnalysis: null,
        refType: 'question', refId: null, sentenceIndex: null,
        passageTitle: null, passageSentence: null,
        canRedo: false, canSimilar: false,
      }],
    });
    const { container } = renderAt('exam', '1');
    await waitFor(() => expect(screen.getByText('题面')).toBeInTheDocument());
    // 我的答案 + 正确答案各一处 KaTeX
    expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).not.toContain('\\frac{1}{5}');
  });

  it('语文专项：questionId=null 时按 JSON 渲染作者/朝代/正文', async () => {
    getDetailMock.mockResolvedValue({
      session: SPECIAL_SESSION,
      questions: [
        {
          questionId: null, questionOrder: 1,
          answerText: '{"author":"李白","dynasty":"唐","body":"床前明月光"}',
          isCorrect: false, score: 0, method: 'exact', analysis: null, judgedAt: null,
          materialText: null,
          questionContent: null, questionAnswer: null, questionAnalysis: null,
          refType: 'passage', refId: 42, sentenceIndex: 0,
          passageTitle: '静夜思', passageSentence: '床前明月光，疑是地上霜。',
          canRedo: false, canSimilar: false,
        },
      ],
    });
    renderAt('special', '5');
    await waitFor(() => expect(screen.getByText('默写专项·静夜思')).toBeInTheDocument());
    expect(screen.getByText('静夜思')).toBeInTheDocument(); // 篇名
    expect(screen.getByText('床前明月光，疑是地上霜。')).toBeInTheDocument(); // 句原文
    expect(screen.getByText('李白')).toBeInTheDocument(); // JSON 解析出 author
    expect(screen.getByText('唐')).toBeInTheDocument();
  });

  it('解析缺失时显示「解析未生成」', async () => {
    getDetailMock.mockResolvedValue({
      session: EXAM_SESSION,
      questions: [{
        questionId: 100, questionOrder: 1, answerText: 'B', isCorrect: null, score: null,
        method: 'failed', analysis: null, judgedAt: null,
        materialText: null,
        questionContent: '题面', questionAnswer: 'C', questionAnalysis: null,
        refType: 'question', refId: null, sentenceIndex: null,
        passageTitle: null, passageSentence: null,
        canRedo: false, canSimilar: false,
      }],
    });
    renderAt('exam', '1');
    await waitFor(() => expect(screen.getByText('解析未生成')).toBeInTheDocument());
    expect(screen.getByText('未判定')).toBeInTheDocument();
  });

  it('source 非法显示不存在 + 返回入口', async () => {
    renderAt('xxx', '1');
    await waitFor(() => expect(screen.getByText(/这条练习记录不存在/)).toBeInTheDocument());
    expect(screen.getByText('返回练习记录')).toBeInTheDocument();
  });

  it('查不到（API reject）显示不存在', async () => {
    getDetailMock.mockRejectedValue(new Error('404'));
    renderAt('exam', '999');
    await waitFor(() => expect(screen.getByText(/这条练习记录不存在/)).toBeInTheDocument());
  });

  it('未作答且可重做：显示「未作答」+ 重做 / 同类型按钮', async () => {
    mockMathDetailWithRules();

    renderAt('exam', '1');
    expect(await screen.findByText('未作答')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重做' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '同类型练习' })).toBeInTheDocument();
  });

  it('canRedo/canSimilar 为 false 时不渲染按钮', async () => {
    getDetailMock.mockResolvedValue({
      session: EXAM_SESSION,
      questions: [{
        questionId: 100, questionOrder: 1, answerText: 'B', isCorrect: false, score: 0,
        method: 'exact', analysis: null, judgedAt: null, materialText: null,
        questionContent: '第1题题面', questionAnswer: 'A', questionAnalysis: null,
        refType: 'question', refId: null, sentenceIndex: null,
        passageTitle: null, passageSentence: null,
        canRedo: false, canSimilar: false,
      }],
    });
    renderAt('exam', '1');
    expect(await screen.findByText('第1题题面')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重做' })).toBeNull();
    expect(screen.queryByRole('button', { name: '同类型练习' })).toBeNull();
    // 没有可同类型的题就不该请求档位
    expect(getPointRulesMock).not.toHaveBeenCalled();
  });

  it('点「同类型练习」弹出题量面板，渲染 1/2/3/5', async () => {
    mockMathDetailWithRules();
    const user = userEvent.setup();
    renderAt('exam', '1');

    await user.click(await screen.findByRole('button', { name: '同类型练习' }));
    for (const n of ['1', '2', '3', '5']) {
      expect(screen.getByRole('button', { name: n })).toBeInTheDocument();
    }
  });

  it('点题量：按该题量请求同类型练习 + 写 similar 交接体 + 带 returnTo 跳转', async () => {
    mockMathDetailWithRules();
    const questions = [{ questionId: 200, text: '同类题', type: 'choice', options: ['A', 'B'], materialText: null }];
    startSimilarMock.mockResolvedValue({ questions, sessionId: 77, title: '同类练习：一次函数 · 3 题' });
    const user = userEvent.setup();
    renderAt('exam', '1');

    await user.click(await screen.findByRole('button', { name: '同类型练习' }));
    await user.click(screen.getByRole('button', { name: '3' }));

    await waitFor(() => expect(startSimilarMock).toHaveBeenCalledWith('exam', 1, 100, 3));
    expect(JSON.parse(sessionStorage.getItem('training:targeted') ?? 'null')).toEqual({
      sessionId: 77,
      questions,
      title: '同类练习：一次函数 · 3 题',
      mode: 'similar',
    });
    const stub = await screen.findByTestId('run-stub');
    expect(stub).toHaveTextContent('/student/training/targeted/run');
    expect(stub).toHaveTextContent('subjectId=1');
    expect(stub).toHaveTextContent(`returnTo=${RETURN_TO}`);
  });

  it('同类型返回 0 题：toast 提示且不跳转', async () => {
    mockMathDetailWithRules();
    startSimilarMock.mockResolvedValue({ questions: [], sessionId: null, title: '' });
    const user = userEvent.setup();
    renderAt('exam', '1');

    await user.click(await screen.findByRole('button', { name: '同类型练习' }));
    await user.click(screen.getByRole('button', { name: '3' }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('info', '暂时没有同类题'));
    expect(sessionStorage.getItem('training:targeted')).toBeNull();
    expect(screen.queryByTestId('run-stub')).toBeNull();
  });

  it('点「重做」：请求重做 + 写 redo 交接体（sessionId=null）+ 跳转', async () => {
    mockMathDetailWithRules();
    const questions = [{ questionId: 100, text: '题干', type: 'choice', options: null, materialText: null }];
    redoMock.mockResolvedValue({ questions, title: '重做：期中卷 · 第 1 题' });
    const user = userEvent.setup();
    renderAt('exam', '1');

    await user.click(await screen.findByRole('button', { name: '重做' }));

    await waitFor(() => expect(redoMock).toHaveBeenCalledWith('exam', 1, 100));
    expect(JSON.parse(sessionStorage.getItem('training:targeted') ?? 'null')).toEqual({
      sessionId: null,
      questions,
      title: '重做：期中卷 · 第 1 题',
      mode: 'redo',
    });
    const stub = await screen.findByTestId('run-stub');
    expect(stub).toHaveTextContent('subjectId=1');
    expect(stub).toHaveTextContent(`returnTo=${RETURN_TO}`);
  });

  it('语文详情：显示同类型按钮，面板只有 1/3/5，按 cn_targeted 取档', async () => {
    getDetailMock.mockResolvedValue({
      session: { ...EXAM_SESSION, subjectId: 2, title: '语文期中卷' },
      questions: [{ ...UNANSWERED_QUESTION }],
    });
    getPointRulesMock.mockResolvedValue(CN_RULES);
    const user = userEvent.setup();
    renderAt('exam', '1');

    await user.click(await screen.findByRole('button', { name: '同类型练习' }));
    expect(screen.getByRole('button', { name: '1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '5' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2' })).toBeNull();
  });

  it('语文详情：点题量请求同类型 + 跳转带 subjectId=2', async () => {
    getDetailMock.mockResolvedValue({
      session: { ...EXAM_SESSION, subjectId: 2, title: '语文期中卷' },
      questions: [{ ...UNANSWERED_QUESTION }],
    });
    getPointRulesMock.mockResolvedValue(CN_RULES);
    const questions = [{ questionId: 7001, text: '文言题', type: 'choice', options: ['A', 'B'], materialText: null }];
    startSimilarMock.mockResolvedValue({ questions, sessionId: 88, title: '同类练习：文言实词与虚词 · 3 题' });
    const user = userEvent.setup();
    renderAt('exam', '1');

    await user.click(await screen.findByRole('button', { name: '同类型练习' }));
    await user.click(screen.getByRole('button', { name: '3' }));

    await waitFor(() => expect(startSimilarMock).toHaveBeenCalledWith('exam', 1, 100, 3));
    const stub = await screen.findByTestId('run-stub');
    expect(stub).toHaveTextContent('subjectId=2');
  });
});
