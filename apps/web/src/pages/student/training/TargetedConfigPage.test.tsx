import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import TargetedConfigPage from './TargetedConfigPage';
import {
  getKnowledgePoints,
  getModelSpecials,
  getMyPointRules,
  getPaperPositions,
  startTargetedPractice,
  type MyPointRules,
  type PointRuleTier,
  type TargetedPracticeQuestion,
  type TrainingKnowledgePoint,
  type TrainingModelSpecial,
  type TrainingPaperPositionsResult,
} from '@/services/api';

/**
 * 数学专项配置页（计划 §3 Task 6）。
 *
 * 为什么必须改读接口：计划一给 `/training/targeted/start` 加了**档位白名单**，
 * 白名单来自家长配置的 `(taskCode, tierKey)`；新默认档位是 1/2/3/5/10。
 * 旧常量里的「8 题」现在会被 400 拒绝，所以档位只能来自 `me/rules`。
 */
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getKnowledgePoints: vi.fn(),
    getMyPointRules: vi.fn(),
    getModelSpecials: vi.fn(),
    getPaperPositions: vi.fn(),
    startTargetedPractice: vi.fn(),
  };
});

const getKpsMock = vi.mocked(getKnowledgePoints);
const getRulesMock = vi.mocked(getMyPointRules);
const getModelSpecialsMock = vi.mocked(getModelSpecials);
const getPaperPositionsMock = vi.mocked(getPaperPositions);
const startMock = vi.mocked(startTargetedPractice);

/** 中考模型：倍长中线（2 题）与手拉手（5 题）。 */
const MODEL_SPECIAL: TrainingModelSpecial = {
  category: 'geometry_synthesis', categoryName: '几何综合',
  model: 'median_doubling', modelName: '倍长中线', questionCount: 2,
};
const HAND_SPECIAL: TrainingModelSpecial = {
  category: 'geometry_synthesis', categoryName: '几何综合',
  model: 'hand_in_hand', modelName: '手拉手', questionCount: 5,
};

// 模型专项只在切到「中考模型」时才拉，各用例默认给一份可练的
beforeEach(() => {
  getModelSpecialsMock.mockReset();
  getModelSpecialsMock.mockResolvedValue({ specials: [MODEL_SPECIAL] });
});

const KPS: TrainingKnowledgePoint[] = [
  { id: 1, name: '数与代数', parentKpId: null, gradeBand: 'junior', questionCount: 10 },
  { id: 2, name: '一元二次方程', parentKpId: 1, gradeBand: 'junior', questionCount: 5 },
];

function tier(
  over: Pick<PointRuleTier, 'tierKey' | 'tierLabel' | 'points'> & Partial<PointRuleTier>,
): PointRuleTier {
  return { dailyLimit: null, completedToday: null, remainingToday: null, isActive: true, ...over };
}

const MATH_TIERS: PointRuleTier[] = [
  tier({ tierKey: '1', tierLabel: '1 题', points: 3 }),
  tier({ tierKey: '3', tierLabel: '3 题', points: 8, dailyLimit: 2, completedToday: 1, remainingToday: 1 }),
  tier({ tierKey: '5', tierLabel: '5 题', points: 12, dailyLimit: 2, completedToday: 2, remainingToday: 0 }),
  tier({ tierKey: '10', tierLabel: '10 题', points: 20, dailyLimit: 1, completedToday: 1, remainingToday: 0 }),
  // 有上限但「今日次数」未计算：remainingToday === null → 不应显示任何状态文案
  tier({ tierKey: '2', tierLabel: '2 题', points: 5, dailyLimit: 3, completedToday: 0, remainingToday: null }),
];

/** 开练成功返回的题单（happy path 默认值；空题单是另一条分支，用例里单独覆盖）。 */
const STARTED_QUESTION: TargetedPracticeQuestion = {
  questionId: 101,
  text: '1 + 1 = ?',
  type: 'choice',
  options: ['A. 1', 'B. 2'],
  materialText: null,
  materialUrl: null,
};

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

/** 手动可控的 Promise：在测试里制造「先发的请求后到」的乱序响应。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 落点探针：断言学科扩展入口带过去的完整路径与 query（防开放重定向）。 */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{`${location.pathname}${location.search}`}</div>;
}

/** 知识点与档位都在 useEffect 里异步拉取，render 必须包在 act 里等它们落地。 */
async function renderPage(initialEntries: string | string[] = '/') {
  const entries = Array.isArray(initialEntries) ? initialEntries : [initialEntries];
  const router = createMemoryRouter(
    [
      // 兼容既有用例：用 '/' 渲染本页
      { path: '/', element: <TargetedConfigPage /> },
      // Task 11：也允许用生产路径 '/student/training/targeted' 渲染本页（spec 真源路径）
      { path: '/student/training/targeted', element: <TargetedConfigPage /> },
      // 开练成功会 navigate 到 run 页；这里要有落点，否则测试环境报「无匹配路由」
      { path: '/student/training/targeted/run', element: <div /> },
      // 学科扩展入口（背单词）的落点，用探针核对 from=targeted
      { path: '/student/training/english/vocabulary', element: <LocationProbe /> },
    ],
    { initialEntries: entries },
  );
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RouterProvider router={router} />);
  });
  return result;
}

function selectKps() {
  fireEvent.click(screen.getByRole('button', { name: '数与代数' }));
  fireEvent.click(screen.getByRole('button', { name: /一元二次方程/ }));
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
    startMock.mockResolvedValue({ questions: [STARTED_QUESTION], sessionId: 77 });
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

  it('dailyLimit 有值但 remainingToday 未计算：不显示状态文案，按钮仍可点并用于开练', async () => {
    await renderPage();
    const notComputed = screen.getByRole('button', { name: /^2 题/ });

    expect(within(notComputed).getByText('+5 分')).toBeTruthy();
    expect(within(notComputed).queryByText(/剩余 \d+ 次|今日已达上限/)).toBeNull();
    expect(notComputed).not.toBeDisabled();

    fireEvent.click(notComputed);
    expect(notComputed.getAttribute('aria-pressed')).toBe('true');

    selectKps();
    await clickStart();

    expect(startMock).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }));
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

describe('TargetedConfigPage sessionId 交接链', () => {
  beforeEach(() => {
    getKpsMock.mockReset();
    getRulesMock.mockReset();
    startMock.mockReset();
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    startMock.mockResolvedValue({ questions: [STARTED_QUESTION], sessionId: 77 });
  });

  it('开练成功后 sessionStorage 存 { sessionId, questions }（run 页据此发分）', async () => {
    await renderPage();
    selectKps();
    await clickStart();

    const stored: unknown = JSON.parse(sessionStorage.getItem('training:targeted') ?? 'null');
    expect(stored).toEqual({ sessionId: 77, questions: [STARTED_QUESTION] });
  });

  it('start 降级返回 sessionId: null 时原样交接（run 页据此不发分）', async () => {
    startMock.mockResolvedValue({ questions: [STARTED_QUESTION], sessionId: null });
    await renderPage();
    selectKps();
    await clickStart();

    const stored: unknown = JSON.parse(sessionStorage.getItem('training:targeted') ?? 'null');
    expect(stored).toEqual({ sessionId: null, questions: [STARTED_QUESTION] });
  });
});


describe('TargetedConfigPage 语文（subjectId=2）', () => {
  beforeEach(() => {
    getKpsMock.mockReset();
    getRulesMock.mockReset();
    startMock.mockReset();
    getKpsMock.mockResolvedValue([
      { id: 11, name: '积累与运用', parentKpId: null, gradeBand: 'junior', questionCount: 8 },
      { id: 12, name: '字词', parentKpId: 11, gradeBand: 'junior', questionCount: 0 },
      { id: 13, name: '病句', parentKpId: 11, gradeBand: 'junior', questionCount: 3 },
    ]);
    getRulesMock.mockResolvedValue({
      tasks: [{
        taskCode: 'cn_targeted',
        taskName: '语文专项',
        tiers: [tier({ tierKey: '3', tierLabel: '3 题', points: 8 })],
      }],
    });
    startMock.mockResolvedValue({ questions: [], sessionId: null });
  });

  it('读学科 query：标题「语文 · 专项」、档位取 cn_targeted、题量来自该组', async () => {
    await renderPage(['/?subjectId=2']);

    expect(screen.getByText('语文 · 专项')).toBeTruthy();
    // 模式切换只给数学（语文没有模型微专题）
    expect(screen.queryByRole('button', { name: '中考模型' })).toBeNull();
    // 只有 cn_targeted 组（数学/英语组不显示）
    expect(screen.getByRole('button', { name: /^3 题/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^15 词/ })).toBeNull();
  });

  it('题型下拉按学科裁剪：全部/选择/填空/简答', async () => {
    await renderPage(['/?subjectId=2']);

    const options = Array.from(
      screen.getByLabelText('题型筛选').querySelectorAll('option'),
    ).map((o) => o.textContent);
    expect(options).toEqual(['全部', '选择', '填空', '简答']);
  });

  it('0 题考点置灰不可选，并显示「暂无题目」', async () => {
    await renderPage(['/?subjectId=2']);
    fireEvent.click(screen.getByRole('button', { name: '积累与运用' }));

    const empty = screen.getByRole('button', { name: /字词/ }) as HTMLButtonElement;
    expect(empty.disabled).toBe(true);
    expect(empty.textContent).toContain('暂无题目');
    // 有题的考点仍可选，并显示题量
    const available = screen.getByRole('button', { name: /病句/ });
    expect((available as HTMLButtonElement).disabled).toBe(false);
    expect(available.textContent).toContain('3 题');
  });
});

describe('按学科取题型与任务码', () => {
  beforeEach(() => {
    getKpsMock.mockReset();
    getRulesMock.mockReset();
    startMock.mockReset();
    getKpsMock.mockResolvedValue(KPS);
  });

  it('物理：题型下拉含「计算」，标题「物理 · 专项」', async () => {
    // mock 只下发 physics_targeted 组：若页面拿错 taskCode，会找不到组、显示「家长已停用」。
    // 这条间接钉住 `usePointTiers(subject?.targetedTaskCode ?? MATH_TASK_CODE)` 用了正确的 taskCode。
    getRulesMock.mockResolvedValue({
      tasks: [{ taskCode: 'physics_targeted', taskName: '物理专项', tiers: MATH_TIERS }],
    });
    renderPage('/student/training/targeted?subjectId=4');

    await waitFor(() => expect(getRulesMock).toHaveBeenCalled());
    expect(screen.getByRole('option', { name: '计算' })).toBeTruthy();
    expect(await screen.findByText('物理 · 专项')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '中考模型' })).toBeNull();
  });

  it('化学：题型下拉不含「计算」，标题「化学 · 专项」', async () => {
    getRulesMock.mockResolvedValue({
      tasks: [{ taskCode: 'chemistry_targeted', taskName: '化学专项', tiers: MATH_TIERS }],
    });
    renderPage('/student/training/targeted?subjectId=5');

    await waitFor(() => expect(getRulesMock).toHaveBeenCalled());
    expect(screen.queryByRole('option', { name: '计算' })).toBeNull();
    expect(screen.queryByRole('button', { name: '中考模型' })).toBeNull();
  });

  it('数学：标题与任务码保持不变（回归钉子）', async () => {
    getRulesMock.mockResolvedValue({
      tasks: [{ taskCode: 'math_targeted', taskName: '数学专项', tiers: MATH_TIERS }],
    });
    renderPage('/student/training/targeted');

    await waitFor(() => expect(getRulesMock).toHaveBeenCalled());
    expect(await screen.findByText('专项练习')).toBeTruthy();
    expect(screen.getByRole('button', { name: '中考模型' })).toBeTruthy();
  });
});

describe('中考模型模式', () => {
  it('数学显示模式切换；切到模型后按 2 题开练并带正确标题', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    getModelSpecialsMock.mockResolvedValue({ specials: [MODEL_SPECIAL] });
    startMock.mockResolvedValue({ questions: [STARTED_QUESTION], sessionId: 77 });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: '中考模型' }));
    await waitFor(() => expect(getModelSpecialsMock).toHaveBeenCalledWith(1));
    expect(await screen.findByText('倍长中线')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始练习' }));
    });
    expect(startMock).toHaveBeenCalledWith({
      subjectId: 1,
      category: 'geometry_synthesis',
      model: 'median_doubling',
      type: null,
      count: 2,
    });
    const stored: unknown = JSON.parse(sessionStorage.getItem('training:targeted') ?? 'null');
    expect(stored).toEqual({
      sessionId: 77, questions: [STARTED_QUESTION], title: '倍长中线',
    });
  });

  it('多模型：切到手拉手，按题池默认 3 题开练', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    getModelSpecialsMock.mockResolvedValue({ specials: [MODEL_SPECIAL, HAND_SPECIAL] });
    startMock.mockResolvedValue({ questions: [STARTED_QUESTION], sessionId: 99 });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: '中考模型' }));
    await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('geometry_synthesis::median_doubling'));
    fireEvent.change(screen.getByLabelText('模型'), {
      target: { value: 'geometry_synthesis::hand_in_hand' },
    });

    expect(await screen.findByRole('button', { name: /^3 题/ })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始练习' }));
    });
    expect(startMock).toHaveBeenCalledWith({
      subjectId: 1,
      category: 'geometry_synthesis',
      model: 'hand_in_hand',
      type: null,
      count: 3,
    });
  });

  it('没有 1/2 档：提示家长开启并禁用', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf([
      tier({ tierKey: '3', tierLabel: '3 题', points: 8 }),
      tier({ tierKey: '5', tierLabel: '5 题', points: 12 }),
    ]));
    getModelSpecialsMock.mockResolvedValue({ specials: [MODEL_SPECIAL] });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '中考模型' }));
    expect(await screen.findByText('家长未开启 1 或 2 题档位，暂不能开练。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始练习' })).toBeDisabled();
  });

  it('可练 0 题：显示暂无可练题目', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    getModelSpecialsMock.mockResolvedValue({
      specials: [{ ...MODEL_SPECIAL, questionCount: 0 }],
    });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '中考模型' }));
    expect(await screen.findByText('暂无可练题目。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始练习' })).toBeDisabled();
  });

  it('模型清单拉取失败：显示固定文案，重试成功后渲染模型', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    getModelSpecialsMock.mockRejectedValueOnce(new Error('boom'));
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: '中考模型' }));
    expect(await screen.findByText('模型专项加载失败')).toBeTruthy();
    // 只给学生向固定文案，不回显网络/后端原文
    expect(screen.queryByText('boom')).toBeNull();
    expect(screen.queryByText(/boom/)).toBeNull();

    getModelSpecialsMock.mockResolvedValue({ specials: [MODEL_SPECIAL] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
    });
    expect(await screen.findByText('倍长中线')).toBeTruthy();
  });

  it('模型模式下档位拉取失败：面板内提示并可重试出档位', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock
      .mockRejectedValueOnce(new Error('tier down'))
      .mockResolvedValue(rulesOf(MATH_TIERS));
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: '中考模型' }));
    expect(await screen.findByText('档位加载失败，请重试')).toBeTruthy();
    // 模型本身已拉到：档位错误不遮住卡片
    expect(await screen.findByText('倍长中线')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
    });
    expect(await screen.findByRole('button', { name: /^2 题/ })).toBeTruthy();
  });

  it('可练 1 题：只给 1 题档，不出现 2 题档，可直接开练', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    getModelSpecialsMock.mockResolvedValue({
      specials: [{ ...MODEL_SPECIAL, questionCount: 1 }],
    });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '中考模型' }));

    expect(await screen.findByRole('button', { name: /^1 题/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^2 题/ })).toBeNull();
    expect(screen.getByRole('button', { name: '开始练习' })).not.toBeDisabled();
  });

  it('可练 1 题但家长没开 1 题档：按 1 题档提示并禁用', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf([
      tier({ tierKey: '2', tierLabel: '2 题', points: 5 }),
      tier({ tierKey: '3', tierLabel: '3 题', points: 8 }),
      tier({ tierKey: '5', tierLabel: '5 题', points: 12 }),
    ]));
    getModelSpecialsMock.mockResolvedValue({
      specials: [{ ...MODEL_SPECIAL, questionCount: 1 }],
    });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '中考模型' }));

    expect(await screen.findByText('家长未开启 1 题档位，暂不能开练。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始练习' })).toBeDisabled();
  });

  it('手动点 1 题档开练：count 用 1，默认的 2 题档不泄漏', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    getModelSpecialsMock.mockResolvedValue({ specials: [MODEL_SPECIAL] });
    startMock.mockResolvedValue({ questions: [STARTED_QUESTION], sessionId: 88 });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '中考模型' }));
    expect(await screen.findByRole('button', { name: /^1 题/ })).toBeTruthy();

    // 默认档是 2 题（eligible 里最大档），改成 1 题后 count 必须跟着改
    fireEvent.click(screen.getByRole('button', { name: /^1 题/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始练习' }));
    });
    expect(startMock).toHaveBeenCalledWith({
      subjectId: 1,
      category: 'geometry_synthesis',
      model: 'median_doubling',
      type: null,
      count: 1,
    });
  });
});

describe('试卷题号模式', () => {
  const POSITIONS = [
    { questionNo: 1, total: 5, wrongCount: 2, untriedCount: 3 },
    { questionNo: 24, total: 2, wrongCount: 1, untriedCount: 1 },
  ];

  beforeEach(() => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    getPaperPositionsMock.mockReset();
    getPaperPositionsMock.mockResolvedValue({
      options: [
        { grade: '初三', semester: 'first', paperCount: 7, typicalQuestionCount: 28 },
      ],
      grade: null, semester: null, typicalQuestionCount: null, positions: [],
    });
    startMock.mockReset();
    startMock.mockResolvedValue({ questions: [STARTED_QUESTION], sessionId: 9 });
  });

  it('切到试卷题号：拉选项+清单，选题号与档位后按 paper 字段开练', async () => {
    getPaperPositionsMock.mockImplementation(async (_s, grade) => grade
      ? { options: [{ grade: '初三', semester: 'first', paperCount: 7, typicalQuestionCount: 28 }],
          grade: '初三', semester: 'first', typicalQuestionCount: 28, positions: POSITIONS }
      : { options: [{ grade: '初三', semester: 'first', paperCount: 7, typicalQuestionCount: 28 }],
          grade: null, semester: null, typicalQuestionCount: null, positions: [] });

    await renderPage('/?subjectId=1');
    fireEvent.click(screen.getByRole('button', { name: '试卷题号' }));
    await waitFor(() => expect(getPaperPositionsMock).toHaveBeenCalledWith(1, '初三', 'first'));

    fireEvent.click(await screen.findByRole('button', { name: '第24题，可练2题' }));
    // 可练 2 题：只应出现 1/2 档，3 档不可选
    await waitFor(() => expect(screen.getByRole('button', { name: /^1 题/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^3 题/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^2 题/ }));
    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));

    await waitFor(() => expect(startMock).toHaveBeenCalledWith({
      subjectId: 1,
      grade: '初三',
      semester: 'first',
      paperQuestionNo: 24,
      type: null,
      count: 2,
    }));
  });

  it('全部做过的题号按 total 参与档位过滤，仍可开练', async () => {
    getPaperPositionsMock.mockImplementation(async (_s, grade) => grade
      ? { options: [{ grade: '初三', semester: 'first', paperCount: 7, typicalQuestionCount: 28 }],
          grade: '初三', semester: 'first', typicalQuestionCount: 28,
          positions: [{ questionNo: 24, total: 3, wrongCount: 0, untriedCount: 0 }] }
      : { options: [{ grade: '初三', semester: 'first', paperCount: 7, typicalQuestionCount: 28 }],
          grade: null, semester: null, typicalQuestionCount: null, positions: [] });

    await renderPage('/?subjectId=1');
    fireEvent.click(screen.getByRole('button', { name: '试卷题号' }));
    fireEvent.click(await screen.findByRole('button', { name: '第24题，可练3题' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^3 题/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^5 题/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^3 题/ }));
    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));
    await waitFor(() => expect(startMock).toHaveBeenCalledWith({
      subjectId: 1, grade: '初三', semester: 'first', paperQuestionNo: 24, type: null, count: 3,
    }));
  });

  it('快速切学期：先发的旧学期响应后到，不得覆盖当前学期的题号与开练载荷', async () => {
    // 同一年级两个学期都有试卷，学期下拉才能切
    const OPTIONS = [
      { grade: '初三', semester: 'first' as const, paperCount: 7, typicalQuestionCount: 28 },
      { grade: '初三', semester: 'second' as const, paperCount: 6, typicalQuestionCount: 26 },
    ];
    const firstCall = deferred<TrainingPaperPositionsResult>();
    const secondCall = deferred<TrainingPaperPositionsResult>();
    getPaperPositionsMock.mockImplementation((_subject, grade, semester) => {
      if (!grade || !semester) {
        return Promise.resolve({
          options: OPTIONS, grade: null, semester: null, typicalQuestionCount: null, positions: [],
        });
      }
      return semester === 'first' ? firstCall.promise : secondCall.promise;
    });

    await renderPage('/?subjectId=1');
    fireEvent.click(screen.getByRole('button', { name: '试卷题号' }));
    await waitFor(() => expect(getPaperPositionsMock).toHaveBeenCalledWith(1, '初三', 'first'));

    // 切到下学期：发出第二次题号清单请求
    fireEvent.change(screen.getByLabelText('学期'), { target: { value: 'second' } });
    await waitFor(() => expect(getPaperPositionsMock).toHaveBeenCalledWith(1, '初三', 'second'));

    // 后发的新学期响应先回来
    await act(async () => {
      secondCall.resolve({
        options: OPTIONS, grade: '初三', semester: 'second', typicalQuestionCount: 26,
        positions: [{ questionNo: 26, total: 2, wrongCount: 1, untriedCount: 1 }],
      });
    });
    expect(await screen.findByRole('button', { name: '第26题，可练2题' })).toBeTruthy();
    expect(screen.getByText('共 26 题')).toBeTruthy();

    // 先发的旧学期响应最后才回来：必须被丢弃，界面不能跳回上学期的题号
    await act(async () => {
      firstCall.resolve({
        options: OPTIONS, grade: '初三', semester: 'first', typicalQuestionCount: 28,
        positions: [{ questionNo: 24, total: 5, wrongCount: 2, untriedCount: 3 }],
      });
    });
    expect(screen.queryByRole('button', { name: /第24题/ })).toBeNull();
    expect(screen.getByRole('button', { name: '第26题，可练2题' })).toBeTruthy();
    expect(screen.getByText('共 26 题')).toBeTruthy();
    expect(screen.queryByText('共 28 题')).toBeNull();

    // 界面看到的是下学期第 26 题，开练载荷必须与之完全一致
    fireEvent.click(screen.getByRole('button', { name: '第26题，可练2题' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^1 题/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^2 题/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始练习' }));
    });
    expect(startMock).toHaveBeenCalledWith({
      subjectId: 1,
      grade: '初三',
      semester: 'second',
      paperQuestionNo: 26,
      type: null,
      count: 2,
    });
  });

  it('非数学不显示试卷题号入口', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    await renderPage('/?subjectId=2');
    expect(screen.queryByRole('button', { name: '试卷题号' })).toBeNull();
  });
});

describe('TargetedConfigPage 学科扩展入口', () => {
  beforeEach(() => {
    getKpsMock.mockReset();
    getRulesMock.mockReset();
    startMock.mockReset();
    getKpsMock.mockResolvedValue([]);
    getRulesMock.mockResolvedValue({
      tasks: [{
        taskCode: 'en_targeted',
        taskName: '英语专项',
        tiers: [tier({ tierKey: '5', tierLabel: '5 题', points: 10 })],
      }],
    });
  });

  it('英语渲染背单词入口，点击进入带 from=targeted 的背单词页', async () => {
    await renderPage('/student/training/targeted?subjectId=3');

    expect(screen.getByText('背单词')).toBeTruthy();
    const enter = screen.getByRole('button', { name: '进入' });

    await act(async () => {
      fireEvent.click(enter);
    });

    expect(screen.getByTestId('location-probe')).toHaveTextContent(
      '/student/training/english/vocabulary?from=targeted',
    );
  });

  it('数学不显示背单词入口（配置驱动，不按学科硬编码）', async () => {
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    await renderPage('/student/training/targeted?subjectId=1');

    expect(screen.queryByText('背单词')).toBeNull();
    expect(screen.queryByRole('button', { name: '进入' })).toBeNull();
  });
});
