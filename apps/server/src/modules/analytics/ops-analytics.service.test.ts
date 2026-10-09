import { describe, expect, it, vi } from 'vitest';
import { OpsAnalyticsService, parseWindow } from './ops-analytics.service.js';
import type {
  EventsPageFilter,
  FunnelStepFilter,
  OpsAnalyticsRepository,
  OpsWindow,
} from './ops-analytics.repo.js';

function svcWith(overrides: Partial<Record<keyof OpsAnalyticsRepository, unknown>>) {
  const repo = {
    overviewSessions: vi.fn(async () => ({ dau: 3, students: 7, totalSeconds: 7200 })),
    answerTotals: vi.fn(async () => ({ answered: 4, correct: 2 })),
    moduleTop: vi.fn(async () => [{ module: 'mainline', students: 5, seconds: 6000 }]),
    modulesWindow: vi.fn(async () => [
      { module: 'mainline', students: 5, seconds: 6000, sessions: 9, answered: 4, correct: 1 },
      { module: 'exam', students: 2, seconds: 1200, sessions: 3, answered: 0, correct: 0 },
    ]),
    funnel: vi.fn(async () => new Map<string, number>()),
    eventsPage: vi.fn(async () => ({ rows: [] as unknown[], total: 0 })),
    ...overrides,
  } as unknown as OpsAnalyticsRepository;
  return { svc: new OpsAnalyticsService(repo), repo };
}

describe('parseWindow', () => {
  it('缺省 = 近 7 天（from = 今天-6，toAt = 明天 00:00，左闭右开）', () => {
    const w = parseWindow();
    expect(w.fromAt).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/);
    expect(w.toAt).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/);
    const from = new Date(w.fromAt.replace(' ', 'T'));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = (today.getTime() - from.getTime()) / 86_400_000;
    expect(diffDays).toBe(6);
  });

  it('显式 from/to：toAt = to + 1 天 00:00:00', () => {
    const w = parseWindow('2026-01-01', '2026-01-07');
    expect(w.fromAt).toBe('2026-01-01 00:00:00');
    expect(w.toAt).toBe('2026-01-08 00:00:00');
  });

  it('todayAt/tomorrowAt 恒为真实「今日」，与查询窗口无关', () => {
    const w = parseWindow('2020-01-01', '2020-01-02');
    expect(w.todayAt).toBe(parseWindow().todayAt);
    expect(w.tomorrowAt).toBe(parseWindow().tomorrowAt);
  });

  it('非法格式 / from 晚于 to → 400/1001', () => {
    expect(() => parseWindow('2026/01/01')).toThrowError(
      expect.objectContaining({ response: { code: 1001, message: 'from 格式应为 YYYY-MM-DD' } }),
    );
    expect(() => parseWindow(undefined, '2026-1-1')).toThrowError(
      expect.objectContaining({ response: { code: 1001, message: 'to 格式应为 YYYY-MM-DD' } }),
    );
    expect(() => parseWindow('2026-01-08', '2026-01-01')).toThrowError(
      expect.objectContaining({ response: expect.objectContaining({ code: 1001 }) }),
    );
  });

  it('格式合法但日期无效（如 2026-02-30 / 2026-13-01）→ 400/1001，不放行到 SQL', async () => {
    await expect(
      (async () => {
        const { svc } = svcWith({});
        return svc.overview({ from: '2026-02-30' });
      })(),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(
      (async () => {
        const { svc } = svcWith({});
        return svc.overview({ to: '2026-13-01' });
      })(),
    ).rejects.toMatchObject({ response: { code: 1001 } });
  });
});

describe('OpsAnalyticsService.overview', () => {
  it('组装响应形状，moduleTop 只留 module/students/seconds', async () => {
    const { svc, repo } = svcWith({});
    const r = await svc.overview({ from: '2026-10-03', to: '2026-10-09' });
    expect(r).toEqual({
      dau: 3,
      wau: 7,
      totalSeconds: 7200,
      totalAnswers: 4,
      accuracy: 0.5,
      moduleTop: [{ module: 'mainline', students: 5, seconds: 6000 }],
    });
    // repo 各方法只 await 一次，窗口参数来自 parseWindow
    expect(repo.overviewSessions).toHaveBeenCalledTimes(1);
    expect(repo.answerTotals).toHaveBeenCalledTimes(1);
    expect(repo.moduleTop).toHaveBeenCalledTimes(1);
    const w = (repo.overviewSessions as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(w.fromAt).toBe('2026-10-03 00:00:00');
    expect(w.toAt).toBe('2026-10-10 00:00:00');
  });

  it('answered=0 → accuracy null（不许写 0）', async () => {
    const { svc } = svcWith({ answerTotals: vi.fn(async () => ({ answered: 0, correct: 0 })) });
    const r = await svc.overview({});
    expect(r.accuracy).toBeNull();
  });
});

describe('OpsAnalyticsService.modules', () => {
  it('逐模块组装，answered=0 → accuracy null', async () => {
    const { svc } = svcWith({});
    const r = await svc.modules({});
    expect(r.items).toEqual([
      { module: 'mainline', students: 5, seconds: 6000, answered: 4, correct: 1, accuracy: 0.25 },
      { module: 'exam', students: 2, seconds: 1200, answered: 0, correct: 0, accuracy: null },
    ]);
  });

  it('窗口参数透传给 repo 一次', async () => {
    const { svc, repo } = svcWith({});
    await svc.modules({ from: '2026-10-01' });
    expect(repo.modulesWindow).toHaveBeenCalledTimes(1);
    const w = (repo.modulesWindow as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(w.fromAt).toBe('2026-10-01 00:00:00');
  });
});

describe('OpsAnalyticsService.funnel', () => {
  it('module 白名单越界（8 个漏斗模块之外）→ 400/1001', async () => {
    const { svc } = svcWith({});
    await expect(svc.funnel({ module: 'aux_qna' })).rejects.toMatchObject({
      response: { code: 1001 },
    });
  });

  it('mainline：每步人数与相对上步转化；★裁决第三步过滤条件传给 repo', async () => {
    const funnel = vi.fn(
      async (_w: OpsWindow, _steps: FunnelStepFilter[]) =>
        new Map<string, number>([
          ['study_session_started', 100],
          ['answer_submitted', 60],
          ['points_awarded', 30],
        ]),
    );
    const { svc } = svcWith({ funnel });
    const r = await svc.funnel({ module: 'mainline' });
    expect(r.module).toBe('mainline');
    expect(r.steps).toEqual([
      { event: 'study_session_started', students: 100 },
      { event: 'answer_submitted', students: 60 },
      { event: 'points_awarded', students: 30 },
    ]);
    expect(r.conversions).toEqual([null, 0.6, 0.5]);

    const [w, steps] = funnel.mock.calls[0];
    expect(w.fromAt).toMatch(/00:00:00$/);
    expect(steps[0]).toMatchObject({
      event: 'study_session_started', extraWhere: 'module = ?', extraParams: ['mainline'],
    });
    expect(steps[1]).toMatchObject({
      event: 'answer_submitted', extraWhere: 'module = ?', extraParams: ['mainline'],
    });
    // ★裁决：mainline 第三步 = points_awarded 且 module IS NULL 且完课 taskCode
    expect(steps[2]).toMatchObject({
      event: 'points_awarded',
      extraWhere: "module IS NULL AND props->>'$.taskCode' = ?",
      extraParams: ['mainline_lesson'],
    });
  });

  it('步骤缺失补 0；上一步人数为 0 → 转化 null', async () => {
    const funnel = vi.fn(
      async (_w: OpsWindow, _steps: FunnelStepFilter[]) =>
        new Map<string, number>([['study_session_started', 10]]),
    );
    const { svc } = svcWith({ funnel });
    const r = await svc.funnel({ module: 'exam' });
    expect(r.steps).toEqual([
      { event: 'study_session_started', students: 10 },
      { event: 'answer_submitted', students: 0 },
      { event: 'exam_submitted', students: 0 },
    ]);
    // 第 2 步：0/10 = 0（真实转化 0）；第 3 步：上一步人数为 0 → null
    expect(r.conversions).toEqual([null, 0, null]);
  });
});

describe('OpsAnalyticsService.events', () => {
  it('分页 20、过滤条件透传 repo，不过滤 tier', async () => {
    const eventsPage = vi.fn(
      async (_q: EventsPageFilter) => ({ rows: [{ id: 1 }] as unknown[], total: 41 }),
    );
    const { svc, repo } = svcWith({ eventsPage });
    const r = await svc.events({
      event: 'page_view', module: 'mainline',
      from: '2026-10-01', to: '2026-10-07', page: '3',
    });
    expect(r).toEqual({ items: [{ id: 1 }], page: 3, pageSize: 20, total: 41 });
    expect(repo.eventsPage).toHaveBeenCalledTimes(1);
    const q = eventsPage.mock.calls[0][0];
    expect(q).toEqual({
      event: 'page_view', module: 'mainline',
      fromAt: '2026-10-01 00:00:00', toAt: '2026-10-08 00:00:00',
      offset: 40, limit: 20,
    });
  });

  it('page 缺省 1；非法 page（0 / 非整数）→ 400/1001', async () => {
    const { svc } = svcWith({});
    expect((await svc.events({})).page).toBe(1);
    await expect(svc.events({ page: '0' })).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(svc.events({ page: 'abc' })).rejects.toMatchObject({ response: { code: 1001 } });
  });
});
