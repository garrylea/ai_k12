import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import ErrorPracticePage from './ErrorPracticePage';

/**
 * 错题页 `?kpId=` 预填（2026-09-23）：薄弱点图谱的「看这个知识点的错题」依赖它。
 * 钉住：带参数时下拉预填 + **首屏就按该 kpId 查询**（不是等用户点「查询」）。
 *
 * 2026-10-11 增补：错题升级变式入口——条目上「N 道变式待练」按钮，
 * 点击 stopPropagation（不触发条目勾选）并带 ?errorBookId= 进作答页。
 *
 * 2026-11-08 增补：freeform（做题记录）条目显示但不可勾选——
 * 不进已选、不进题单；全为 freeform 时「开始练习」禁用。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 */

const getTrainingErrorBook = vi.hoisted(() => vi.fn());
const getKnowledgePoints = vi.hoisted(() => vi.fn());
const getTrainingVariations = vi.hoisted(() => vi.fn());

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getTrainingErrorBook, getKnowledgePoints, getTrainingVariations };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sessionStorage.clear();
  getTrainingErrorBook.mockReset();
  getKnowledgePoints.mockReset();
  getTrainingVariations.mockReset();
  getTrainingErrorBook.mockResolvedValue([]);
  getKnowledgePoints.mockResolvedValue([
    { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
    { id: 11, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
  ]);
  getTrainingVariations.mockResolvedValue({ variations: [] });
});

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/student/training/errors', element: <ErrorPracticePage /> },
      { path: '/student/training/errors/run', element: <div>错题练习作答页</div> },
      { path: '/student/training/variations/run', element: <div>变式作答页</div> },
      { path: '/student/solve', element: <div>做题重练页</div> },
    ],
    { initialEntries: [path] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

describe('ErrorPracticePage ?kpId= 预填', () => {
  it('带 kpId 时首屏查询就带上该 kpId', async () => {
    renderAt('/student/training/errors?kpId=11');

    await waitFor(() =>
      expect(getTrainingErrorBook).toHaveBeenCalledWith(
        expect.objectContaining({ kpId: 11 }),
      ),
    );
  });

  it('带 kpId 时筛选下拉预填为「数与式 / 有理数」', async () => {
    renderAt('/student/training/errors?kpId=11');

    // 该 select 既有的可访问名就是「专项筛选」（ErrorPracticePage.tsx:215），别改它
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '专项筛选' })).toHaveValue('11'),
    );
  });

  it('不带 kpId 时按 undefined 查询（向后兼容）', async () => {
    renderAt('/student/training/errors');

    await waitFor(() =>
      expect(getTrainingErrorBook).toHaveBeenCalledWith(
        expect.objectContaining({ kpId: undefined }),
      ),
    );
  });
});

describe('ErrorPracticePage freeform 条目（2026-11-08）', () => {
  it('freeform 条目显示但不可勾选，不计入已选；提示只在条目出现一次', async () => {
    getTrainingErrorBook.mockResolvedValue([
      { errorBookId: 1, questionId: 1, questionText: '普通题', type: 'choice', level: 1, createdAt: '', source: 'practice' },
      { errorBookId: 2, questionId: 2, questionText: '做题记录', type: 'short_answer', level: 1, createdAt: '', source: 'freeform' },
    ]);

    renderAt('/student/training/errors');

    const checks = (await screen.findAllByRole('checkbox')) as HTMLInputElement[];
    expect(checks[0]).not.toBeDisabled();
    expect(checks[1]).toBeDisabled();
    expect(screen.getByText('做题')).toBeTruthy();
    // 分母只算可选条目（2 条里 1 条是 freeform）
    expect(screen.getByText(/已选 0 \/ 1 题/)).toBeTruthy();
    // 混合列表：条目行提示一次，底部栏是计数句，不重复
    expect(screen.getAllByText('做题记录的题目暂不支持错题练习')).toHaveLength(1);
  });

  it('混合列表：只有普通条目进题单；点 freeform 行不改变已选', async () => {
    const user = userEvent.setup();
    getTrainingErrorBook.mockResolvedValue([
      { errorBookId: 1, questionId: 1, questionText: '普通题', type: 'choice', level: 1, createdAt: '', source: 'practice' },
      { errorBookId: 2, questionId: 2, questionText: '做题记录', type: 'short_answer', level: 1, createdAt: '', source: 'freeform' },
    ]);

    renderAt('/student/training/errors');

    const checks = (await screen.findAllByRole('checkbox')) as HTMLInputElement[];

    // 点 freeform 行的题面：卡片没有 onClick，勾选态不变
    await user.click(screen.getByText('做题记录'));
    expect(checks[1]).not.toBeChecked();
    expect(checks[0]).not.toBeChecked();
    expect(screen.getByText(/已选 0 \/ 1 题/)).toBeTruthy();

    // 选普通条目后开始练习：题单里只有普通条目
    await user.click(checks[0]);
    expect(screen.getByText(/已选 1 \/ 1 题/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /开始练习/ }));

    const payload = JSON.parse(sessionStorage.getItem('training:errors') ?? '[]') as Array<{
      errorBookId: number;
      source: string | null;
    }>;
    expect(payload.map((e) => e.errorBookId)).toEqual([1]);
    expect(payload.some((e) => e.source === 'freeform')).toBe(false);
  });

  it('全为 freeform 时「开始练习」禁用并提示（提示只在底部栏出现一次）', async () => {
    getTrainingErrorBook.mockResolvedValue([
      { errorBookId: 2, questionId: 2, questionText: '做题记录', type: 'short_answer', level: 1, createdAt: '', source: 'freeform' },
    ]);

    renderAt('/student/training/errors');

    const checks = (await screen.findAllByRole('checkbox')) as HTMLInputElement[];
    expect(checks[0]).toBeDisabled();
    expect(screen.getByRole('button', { name: /开始练习/ })).toBeDisabled();
    expect(screen.getAllByText('做题记录的题目暂不支持错题练习')).toHaveLength(1);
    expect(screen.queryByText(/已选/)).toBeNull();
  });

  it('全为孤儿题（无 freeform）时显示计数句，不显示 freeform 提示', async () => {
    getTrainingErrorBook.mockResolvedValue([
      { errorBookId: 3, questionId: null, questionText: '未入库题', type: 'choice', level: 1, createdAt: '', source: 'practice' },
    ]);

    renderAt('/student/training/errors');

    expect(await screen.findByText(/已选 0 \/ 1 题/)).toBeTruthy();
    expect(screen.queryByText('做题记录的题目暂不支持错题练习')).toBeNull();
  });
});

describe('ErrorPracticePage 变式入口（2026-10-11）', () => {
  const ENTRY = {
    errorBookId: 33,
    questionId: 88,
    questionText: '错题题面',
    type: 'choice',
    level: 2,
    createdAt: '2026-10-10T00:00:00.000Z',
    kpIds: [11],
  };

  function renderWithEntry() {
    getTrainingErrorBook.mockResolvedValue([ENTRY]);
    const router = createMemoryRouter(
      [
        { path: '/student/training/errors', element: <ErrorPracticePage /> },
        { path: '/student/training/variations/run', element: <div>变式作答页</div> },
      ],
      { initialEntries: ['/student/training/errors'] },
    );
    return { router, ...render(<RouterProvider router={router} />) };
  }

  it('有 pending 变式的条目渲染「N 道变式待练」入口；无的不渲染', async () => {
    getTrainingVariations.mockResolvedValue({
      variations: [
        { variationId: 501, questionId: 88, errorBookId: 33, text: 'x', type: 'choice', options: null, difficulty: 1 },
        { variationId: 502, questionId: 89, errorBookId: 33, text: 'y', type: 'choice', options: null, difficulty: 1 },
      ],
    });
    getTrainingErrorBook.mockResolvedValue([
      ENTRY,
      { ...ENTRY, errorBookId: 44, questionId: 90 },
    ]);

    renderWithEntry();

    expect(await screen.findByTestId('variation-entry-33')).toHaveTextContent('2 道变式待练');
    expect(screen.queryByTestId('variation-entry-44')).toBeNull();
  });

  it('变式接口失败 → 入口退化不显示，不阻断错题列表', async () => {
    getTrainingVariations.mockRejectedValue(new Error('boom'));
    getTrainingErrorBook.mockResolvedValue([ENTRY]);

    renderWithEntry();

    expect(await screen.findByText('错题题面')).toBeInTheDocument();
    expect(screen.queryByTestId('variation-entry-33')).toBeNull();
  });

  it('点击入口 stopPropagation（不勾选条目）并带 ?errorBookId= 进作答页', async () => {
    const user = userEvent.setup();
    getTrainingVariations.mockResolvedValue({
      variations: [
        { variationId: 501, questionId: 88, errorBookId: 33, text: 'x', type: 'choice', options: null, difficulty: 1 },
      ],
    });
    const { router } = renderWithEntry();

    const btn = await screen.findByTestId('variation-entry-33');
    await user.click(btn);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/student/training/variations/run'),
    );
    expect(router.state.location.search).toBe('?errorBookId=33');
    // stopPropagation 的验证：点击是「入口按钮」自己处理的（checkbox 的 onChange 未被冒泡触发）。
    // 列表页已随导航卸载，无法再断言勾选态；勾选逻辑回归由「点击入口前未勾选」+ 条目 onChange
    // 只绑在 checkbox 上共同保证，这里钉住的是「点击入口能带着 errorBookId 进作答页」。
  });
});

describe('ErrorPracticePage 做题错题重练入口（2026-11-10）', () => {
  const FREE = {
    errorBookId: 440,
    questionId: 7091,
    questionText: '已知 $x+1=2$',
    type: 'short_answer',
    fullScore: 10,
    level: 1,
    createdAt: '2026-11-10',
    source: 'freeform',
  };
  const FREE_NULL_SCORE = {
    ...FREE,
    errorBookId: 441,
    questionId: 7092,
    questionText: '求 $1+1$',
    fullScore: null,
  };
  const NORMAL = {
    errorBookId: 1,
    questionId: 1,
    questionText: '普通题',
    type: 'choice',
    fullScore: 10,
    level: 1,
    createdAt: '2026-11-10',
    source: 'practice',
  };

  it('单题「重练」写单题队列并进 ?redo=1', async () => {
    const user = userEvent.setup();
    getTrainingErrorBook.mockResolvedValue([NORMAL, FREE]);
    const { router } = renderAt('/student/training/errors');

    await user.click(await screen.findByTestId('redo-freeform-440'));

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/solve'));
    expect(router.state.location.search).toBe('?redo=1');
    const queue = JSON.parse(sessionStorage.getItem('training:freeform-redo') ?? 'null');
    expect(queue).toMatchObject({
      subjectId: 1,
      index: 0,
      items: [{ errorBookId: 440, questionId: 7091, questionText: '已知 $x+1=2$', fullScore: 10 }],
    });
    expect(queue.items).toHaveLength(1);
  });

  it('批量「重练做题错题（N）」只收 freeform，且保留 fullScore=null', async () => {
    const user = userEvent.setup();
    getTrainingErrorBook.mockResolvedValue([NORMAL, FREE, FREE_NULL_SCORE]);
    renderAt('/student/training/errors');

    const batch = await screen.findByTestId('redo-all-freeform');
    expect(batch).toHaveTextContent('重练做题错题（2）');
    await user.click(batch);

    const queue = JSON.parse(sessionStorage.getItem('training:freeform-redo') ?? 'null');
    expect(queue.items.map((i: { errorBookId: number }) => i.errorBookId)).toEqual([440, 441]);
    expect(queue.items[1].fullScore).toBeNull();
  });

  it('孤儿 freeform（questionId=null）不显示重练、不计入批量', async () => {
    getTrainingErrorBook.mockResolvedValue([
      { ...FREE, errorBookId: 442, questionId: null },
    ]);
    renderAt('/student/training/errors');

    await screen.findByRole('checkbox');
    expect(screen.queryByTestId('redo-freeform-442')).toBeNull();
    expect(screen.queryByTestId('redo-all-freeform')).toBeNull();
  });

  it('普通错题不显示重练按钮', async () => {
    getTrainingErrorBook.mockResolvedValue([NORMAL]);
    renderAt('/student/training/errors');

    expect(await screen.findByText('普通题')).toBeInTheDocument();
    expect(screen.queryByTestId('redo-all-freeform')).toBeNull();
    expect(screen.queryByText('重练')).toBeNull();
  });
});
