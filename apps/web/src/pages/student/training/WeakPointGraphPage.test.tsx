import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import WeakPointGraphPage from './WeakPointGraphPage';
import type { KnowledgeGraphMastery, WeakPointRecommendation } from '@/services/api';

/**
 * 薄弱点图谱页（spec §6）。
 *
 * 钉住：折叠树默认收起、展开出二级、点 chip 出详情、推荐条两态（有候选 / 引导）、
 * 推荐拉取失败时**只降级推荐条**（图谱仍渲染）、confidence 三态渲染各异、页脚口径。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 */

const getKnowledgeGraphMastery = vi.hoisted(() => vi.fn());
const getWeakPoints = vi.hoisted(() => vi.fn());
const getMyPointRules = vi.hoisted(() => vi.fn());
const startTargetedPractice = vi.hoisted(() => vi.fn());

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getKnowledgeGraphMastery, getWeakPoints, getMyPointRules, startTargetedPractice };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

beforeEach(() => {
  getKnowledgeGraphMastery.mockReset();
  getWeakPoints.mockReset();
  getMyPointRules.mockReset();
  startTargetedPractice.mockReset();
  localStorage.setItem('userId', '7');
  getMyPointRules.mockResolvedValue({
    tasks: [{ taskCode: 'math_targeted', taskName: '数学专项', tiers: [{ tierKey: '1' }, { tierKey: '3' }, { tierKey: '10' }] }],
  });
});

/** 一级 1 下有 11（ok/level2）、12（insufficient）、13（none）。 */
function mastery(overrides: Partial<KnowledgeGraphMastery> = {}): KnowledgeGraphMastery {
  return {
    subjectId: 1,
    nodes: [
      { id: 1, name: '数与式', parentId: null, masteryScore: null, level: null, correctCount: null, errorCount: null, lastSeenAt: null, sampleSize: 0, confidence: 'none', availableQuestionCount: 0 },
      { id: 11, name: '有理数', parentId: 1, masteryScore: 0.4, level: 2, correctCount: 4, errorCount: 6, lastSeenAt: '2026-09-20T10:00:00.000Z', sampleSize: 10, confidence: 'ok', availableQuestionCount: 7 },
      { id: 12, name: '整式', parentId: 1, masteryScore: 0, level: 0, correctCount: 0, errorCount: 1, lastSeenAt: '2026-09-19T10:00:00.000Z', sampleSize: 1, confidence: 'insufficient', availableQuestionCount: 3 },
      { id: 13, name: '分式', parentId: 1, masteryScore: null, level: null, correctCount: null, errorCount: null, lastSeenAt: null, sampleSize: 0, confidence: 'none', availableQuestionCount: 5 },
    ],
    coverage: { coveredQuestions: 205, totalQuestions: 457, uncoveredUnclearedErrors: 4 },
    ...overrides,
  };
}

function recommendation(): WeakPointRecommendation {
  return {
    subjectId: 1,
    candidates: [
      { knowledgePointId: 11, name: '有理数', parentId: 1, masteryScore: 0.4, level: 2, correctCount: 4, errorCount: 6, sampleSize: 10, availableQuestionCount: 7, lastSeenAt: '2026-09-20T10:00:00.000Z' },
    ],
    recommendation: { knowledgePointId: 11, name: '有理数', parentId: 1, masteryScore: 0.4, level: 2, correctCount: 4, errorCount: 6, sampleSize: 10, availableQuestionCount: 7, lastSeenAt: '2026-09-20T10:00:00.000Z' },
    reason: 'ok',
  };
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/student/training/weak-points', element: <WeakPointGraphPage /> },
      { path: '/student/training/targeted/run', element: <div>专项作答页桩</div> },
      { path: '/student/training/errors', element: <div>错题页桩</div> },
      { path: '/student/training/targeted', element: <div>专项配置页桩</div> },
      { path: '/student/training/exam', element: <div>考试页桩</div> },
    ],
    { initialEntries: ['/student/training/weak-points'] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

async function renderSettled() {
  const utils = renderPage();
  expect(await screen.findByText('数与式')).toBeInTheDocument();
  return utils;
}

describe('WeakPointGraphPage 折叠树', () => {
  it('默认全部收起：一级可见、二级不可见', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();

    expect(screen.getByText('数与式')).toBeInTheDocument();
    expect(screen.queryByText('有理数')).toBeNull();
  });

  it('点一级展开出二级；再点收起', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));
    expect(screen.getByText('有理数')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));
    await waitFor(() => expect(screen.queryByText('有理数')).toBeNull());
  });

  it('一级行显示「N 个待补」（只看有结论的 ok 子项，level ≤ 2 计数）', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();

    expect(screen.getByText('1 个待补')).toBeInTheDocument();
  });
});

describe('WeakPointGraphPage 详情栏', () => {
  it('未选中时显示提示文案', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();

    expect(screen.getByText('点左侧知识点看详情')).toBeInTheDocument();
  });

  it('点二级 chip 后详情栏显示对错数与样本可信度', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));
    fireEvent.click(screen.getByRole('button', { name: '有理数' }));

    expect(screen.getByText('对 4 错 6')).toBeInTheDocument();
    // 精确串（非正则）：推荐条里的「… · 样本 10 题 · …」整段文本不等于它，只有详情栏那行命中
    expect(screen.getByText('样本 10 题')).toBeInTheDocument();
  });

  it('样本不足的 KP：详情栏注明「暂不判定强弱」', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));
    fireEvent.click(screen.getByRole('button', { name: '整式' }));

    expect(screen.getByText(/样本不足（<5 题），暂不判定强弱/)).toBeInTheDocument();
  });

  it('从未作答的 KP：详情栏显示「未开始」，不显示百分比', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));
    fireEvent.click(screen.getByRole('button', { name: '分式' }));

    expect(screen.getByText('未开始')).toBeInTheDocument();
    expect(screen.queryByText('0%')).toBeNull();
  });
});

describe('WeakPointGraphPage 推荐条', () => {
  it('有候选：显示「最该补：X」+ 样本 + 可抽题数 + 两个动作', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();

    expect(screen.getByText(/最该补：有理数/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始补这个' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '看这个知识点的错题' })).toBeInTheDocument();
  });

  it('无候选：转引导态，显示引导文案 + [去专项练习] / [去考试]', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue({ subjectId: 1, candidates: [], recommendation: null, reason: 'no_qualified_candidate' });

    await renderSettled();

    expect(screen.getByText(/还没有足够的数据来判断你的薄弱点/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去专项练习' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去考试' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始补这个' })).toBeNull();
  });

  it('推荐拉取失败：推荐条整条不渲染，但树照常渲染', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockRejectedValue(new Error('boom'));

    await renderSettled();

    expect(screen.queryByText(/最该补/)).toBeNull();
    expect(screen.queryByText(/还没有足够的数据/)).toBeNull();
    expect(screen.getByText('数与式')).toBeInTheDocument();
  });

  it('「开始补这个」按 ≥3 的最小档开练并跳作答页', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());
    startTargetedPractice.mockResolvedValue({
      sessionId: 3,
      questions: [{ questionId: 1, text: 't', type: 'choice', options: null }],
    });

    const { router } = await renderSettled();
    // 档位是异步拉的，到位前按钮 disabled —— 点击会静默失效，必须先等它可用
    await waitFor(() => expect(screen.getByRole('button', { name: '开始补这个' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '开始补这个' }));

    await waitFor(() =>
      expect(startTargetedPractice).toHaveBeenCalledWith({ subjectId: 1, kpId: 11, type: null, count: 3 }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/student/training/targeted/run'),
    );
  });

  it('抽到空题单：留在本页并提示，不跳转', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());
    startTargetedPractice.mockResolvedValue({ sessionId: null, questions: [] });

    const { router } = await renderSettled();
    await waitFor(() => expect(screen.getByRole('button', { name: '开始补这个' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '开始补这个' }));

    expect(await screen.findByText(/暂时抽不到这个知识点的题/)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/student/training/weak-points');
  });

  it('「看这个知识点的错题」带 kpId 跳错题页', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    const { router } = await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: '看这个知识点的错题' }));

    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        '/student/training/errors?kpId=11',
      ),
    );
  });
});

describe('WeakPointGraphPage 档位状态（靠界面表达，不加说明文案）', () => {
  it('档位加载失败：主 CTA 换成「重试」控件，点它能重新拉到档位', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());
    getMyPointRules.mockRejectedValueOnce(new Error('boom'));

    await renderSettled();

    // 失败不是「灰着不动」：给可操作的重试控件，而不是一行说明文字
    expect(screen.queryByRole('button', { name: '开始补这个' })).toBeNull();
    const retry = screen.getByRole('button', { name: '重试' });

    getMyPointRules.mockResolvedValue({
      tasks: [{ taskCode: 'math_targeted', taskName: '数学专项', tiers: [{ tierKey: '3' }] }],
    });
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByRole('button', { name: '开始补这个' })).toBeEnabled());
  });

  it('家长停用全部档位：不渲染点不动的死按钮，只留「看这个知识点的错题」', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());
    getMyPointRules.mockResolvedValue({
      tasks: [{ taskCode: 'math_targeted', taskName: '数学专项', tiers: [] }],
    });

    await renderSettled();

    expect(screen.queryByRole('button', { name: '开始补这个' })).toBeNull();
    // 能用的动作仍在，学生不至于无路可走
    expect(screen.getByRole('button', { name: '看这个知识点的错题' })).toBeInTheDocument();
  });

  it('档位加载中：CTA 转圈（loading），不是静默置灰', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());
    getMyPointRules.mockReturnValue(new Promise(() => {})); // 永不 resolve → 停在加载态

    renderPage();

    // 渲染出来（区别于 unavailable 的「不渲染」）+ disabled + 有 spinner
    const cta = await screen.findByRole('button', { name: '开始补这个' });
    expect(cta).toBeDisabled();
    expect(cta.querySelector('.animate-spin')).not.toBeNull();
  });
});

describe('WeakPointGraphPage confidence 三态渲染', () => {
  it('ok 用 brand 橘红实底；insufficient / none 用中性灰', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));

    expect(screen.getByRole('button', { name: '有理数' }).style.background).toContain('rgba(255, 107, 53');
    expect(screen.getByRole('button', { name: '整式' }).style.background).toContain('var(--bg-subtle)');
    expect(screen.getByRole('button', { name: '分式' }).style.background).toContain('var(--bg-subtle)');
  });

  it('insufficient 额外带虚线边，none 不带', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));

    expect(screen.getByRole('button', { name: '整式' }).className).toContain('border-dashed');
    expect(screen.getByRole('button', { name: '分式' }).className).not.toContain('border-dashed');
  });
});

describe('WeakPointGraphPage 页脚与错误态', () => {
  it('页脚显示覆盖数与未标注错题数，并可跳错题页', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    const { router } = await renderSettled();

    expect(screen.getByText(/205 \/ 457/)).toBeInTheDocument();
    expect(screen.getByText(/另有 4 道未标注知识点的题/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '去错题页看' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/errors'));
  });

  it('未标注错题为 0 时不渲染页脚那半句', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(
      mastery({ coverage: { coveredQuestions: 205, totalQuestions: 457, uncoveredUnclearedErrors: 0 } }),
    );
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();

    expect(screen.queryByText(/另有 0 道/)).toBeNull();
  });

  it('mastery 拉取失败：显示重试，不留白', async () => {
    getKnowledgeGraphMastery.mockRejectedValue(new Error('boom'));
    getWeakPoints.mockResolvedValue(recommendation());

    renderPage();

    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('全灰树不显示「暂无数据」（不是错误态）', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(
      mastery({
        nodes: [
          { id: 1, name: '数与式', parentId: null, masteryScore: null, level: null, correctCount: null, errorCount: null, lastSeenAt: null, sampleSize: 0, confidence: 'none', availableQuestionCount: 0 },
        ],
      }),
    );
    getWeakPoints.mockResolvedValue({ subjectId: 1, candidates: [], recommendation: null, reason: 'no_qualified_candidate' });

    await renderSettled();

    expect(screen.queryByText('暂无数据')).toBeNull();
    expect(screen.getByText('数与式')).toBeInTheDocument();
    expect(screen.getByText('未开始')).toBeInTheDocument();
  });
});
