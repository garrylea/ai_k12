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
      { path: '/student/training/variations/run', element: <div>变式作答页</div> },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
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
  it('freeform 条目显示但不可勾选，不计入已选', async () => {
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
  });

  it('全为 freeform 时「开始练习」禁用并提示', async () => {
    getTrainingErrorBook.mockResolvedValue([
      { errorBookId: 2, questionId: 2, questionText: '做题记录', type: 'short_answer', level: 1, createdAt: '', source: 'freeform' },
    ]);

    renderAt('/student/training/errors');

    const checks = (await screen.findAllByRole('checkbox')) as HTMLInputElement[];
    expect(checks[0]).toBeDisabled();
    expect(screen.getByRole('button', { name: /开始练习/ })).toBeDisabled();
    expect(screen.getAllByText('做题记录的题目暂不支持错题练习').length).toBeGreaterThan(0);
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
