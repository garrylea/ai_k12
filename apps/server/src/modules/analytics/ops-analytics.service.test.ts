import { describe, expect, it, vi } from 'vitest';
import { OpsAnalyticsService, parseWindow } from './ops-analytics.service.js';
import type {
  EventsPageFilter,
  FunnelStepFilter,
  LlmCallsPageFilter,
  OpsAnalyticsRepository,
  OpsWindow,
  RequestsPageFilter,
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
    deviceDistributions: vi.fn(async () => ({
      platform_class: [], screen_class: [], input_type: [], app_shell: [], browser: [],
    })),
    answersByOutcome: vi.fn(async () => []),
    sessionsByOutcome: vi.fn(async () => []),
    multiDevice: vi.fn(async () => []),
    switches: vi.fn(async () => ({ count: 0, students: 0 })),
    retentionCohort: vi.fn(async () => [] as number[]),
    retentionDay: vi.fn(async () => 0),
    llmTokenGroups: vi.fn(async () => []),
    llmTokensOverview: vi.fn(async () => ({ attributed: 0, unattributed: 0, unavailableCalls: 0 })),
    qualityApi: vi.fn(async () => ({ total: 0, failures: 0 })),
    qualityErrorCodes: vi.fn(async () => [] as { code: number; count: number }[]),
    qualityLlm: vi.fn(async () => ({ calls: 0, timeouts: 0, fallbacks: 0, attributed: 0 })),
    contentQuality: vi.fn(async () => ({
      questionsWithoutStandardAnswer: 0, kpCovered: 0, kpTotal: 0, wordWrong: 0, wordTotal: 0,
    })),
    llmCallsPage: vi.fn(async () => ({ rows: [] as unknown[], total: 0 })),
    requestsPage: vi.fn(async () => ({ rows: [] as unknown[], total: 0 })),
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

describe('OpsAnalyticsService.retention', () => {
  it('D{n} = cohort 学生在 cohortStart+offset 当日有会话的人数 ÷ cohortSize；日边界应用层算好', async () => {
    const retentionCohort = vi.fn(async () => [1, 2]);
    const retentionDay = vi.fn(
      async (_ids: number[], dayAt: string, _dayNextAt: string) =>
        dayAt.startsWith('2026-10-02') ? 1 : 2,
    );
    const { svc, repo } = svcWith({ retentionCohort, retentionDay });
    const r = await svc.retention({ cohortStart: '2026-10-01' });
    expect(r).toEqual({
      cohortStart: '2026-10-01',
      cohortSize: 2,
      days: [
        { offset: 1, retained: 1, rate: 0.5 },
        { offset: 7, retained: 2, rate: 1 },
        { offset: 30, retained: 2, rate: 1 },
      ],
    });
    expect(repo.retentionDay).toHaveBeenCalledTimes(3);
    // 当日边界由应用层算好传入（cohortStart + offset 天 00:00 起，次日 00:00 止）
    expect(retentionDay.mock.calls[0][1]).toBe('2026-10-02 00:00:00');
    expect(retentionDay.mock.calls[0][2]).toBe('2026-10-03 00:00:00');
    expect(retentionDay.mock.calls[1][1]).toBe('2026-10-08 00:00:00');
    expect(retentionDay.mock.calls[1][2]).toBe('2026-10-09 00:00:00');
  });

  it('days 缺省 [1,7,30]；自定义去重升序（"7,1,1" → [1,7]）', async () => {
    const { svc, repo } = svcWith({ retentionCohort: vi.fn(async () => [1]) });
    await svc.retention({ cohortStart: '2026-10-01' });
    expect(repo.retentionDay).toHaveBeenCalledTimes(3);
    await svc.retention({ cohortStart: '2026-10-01', days: '7,1,1' });
    expect(repo.retentionDay).toHaveBeenCalledTimes(5);
    const dayAts = (repo.retentionDay as ReturnType<typeof vi.fn>)
      .mock.calls.slice(3)
      .map((c) => c[1]);
    expect(dayAts).toEqual(['2026-10-02 00:00:00', '2026-10-08 00:00:00']);
  });

  it('cohortSize=0 → 各 rate null、retained 0，且不查 D{n}', async () => {
    const { svc, repo } = svcWith({});
    const r = await svc.retention({ cohortStart: '2026-10-01' });
    expect(r.cohortSize).toBe(0);
    expect(r.days).toEqual([
      { offset: 1, retained: 0, rate: null },
      { offset: 7, retained: 0, rate: null },
      { offset: 30, retained: 0, rate: null },
    ]);
    expect(repo.retentionDay).not.toHaveBeenCalled();
  });

  it('cohortStart 缺失 / 非法（含 2026-02-30 滚动日）、days 非法 → 400/1001', async () => {
    const { svc } = svcWith({});
    await expect(svc.retention({})).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(svc.retention({ cohortStart: '2026-02-30' })).rejects.toMatchObject({
      response: { code: 1001 },
    });
    await expect(svc.retention({ cohortStart: '2026-10-01', days: '1,x' })).rejects.toMatchObject({
      response: { code: 1001 },
    });
    await expect(svc.retention({ cohortStart: '2026-10-01', days: '0' })).rejects.toMatchObject({
      response: { code: 1001 },
    });
  });
});

describe('OpsAnalyticsService.devices', () => {
  it('五维分布组装；accuracy 只给 platformClass（其余维度恒 null），窗口透传一次', async () => {
    const deviceDistributions = vi.fn(async (_w: OpsWindow) => ({
      platform_class: [{ key: 'ipad', students: 5, seconds: 6000, sessions: 9 }],
      screen_class: [{ key: 'desktop', students: 3, seconds: 1000, sessions: 4 }],
      input_type: [],
      app_shell: [],
      browser: [],
    }));
    const answersByOutcome = vi.fn(async (_w: OpsWindow, outcome: string) =>
      outcome === 'platform_class'
        ? [{ key: 'ipad', students: 3, answered: 8, correct: 4 }]
        : [],
    );
    const { svc, repo } = svcWith({
      deviceDistributions,
      answersByOutcome,
      multiDevice: vi.fn(async () => [{ count: 2, students: 3 }]),
      switches: vi.fn(async () => ({ count: 7, students: 4 })),
    });
    const r = await svc.devices({ from: '2026-10-03', to: '2026-10-09' });
    expect(r.distributions.platformClass).toEqual([
      { key: 'ipad', students: 5, seconds: 6000, sessions: 9, accuracy: 0.5 },
    ]);
    expect(r.distributions.screenClass).toEqual([
      { key: 'desktop', students: 3, seconds: 1000, sessions: 4, accuracy: null },
    ]);
    expect(r.distributions.inputType).toEqual([]);
    expect(r.distributions.appShell).toEqual([]);
    expect(r.distributions.browser).toEqual([]);
    expect(r.multiDevice).toEqual([{ count: 2, students: 3 }]);
    expect(r.switches).toEqual({ count: 7, students: 4 });
    const w = deviceDistributions.mock.calls[0][0];
    expect(w.fromAt).toBe('2026-10-03 00:00:00');
    expect(w.toAt).toBe('2026-10-10 00:00:00');
    expect(repo.answersByOutcome).toHaveBeenCalledTimes(1);
  });
});

describe('OpsAnalyticsService.cohortCompare', () => {
  it('metric / outcome 白名单越界 → 400/1001（browser 不在 outcome 白名单）', async () => {
    const { svc } = svcWith({});
    await expect(
      svc.cohortCompare({ metric: 'tokens', outcome: 'platform_class' }),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(
      svc.cohortCompare({ metric: 'totalSeconds', outcome: 'browser' }),
    ).rejects.toMatchObject({ response: { code: 1001 } });
  });

  it('totalSeconds/daysActive 走时长侧（study_sessions），value=组内人均；0 人 → null；响应必带免责声明', async () => {
    const sessionsByOutcome = vi.fn(async (_w: OpsWindow) => [
      { key: 'ipad', students: 4, seconds: 800, studentDays: 10 },
      { key: 'mac', students: 0, seconds: 0, studentDays: 0 },
    ]);
    const { svc, repo } = svcWith({ sessionsByOutcome });
    const r = await svc.cohortCompare({ metric: 'totalSeconds', outcome: 'platform_class' });
    expect(r).toEqual({
      metric: 'totalSeconds',
      outcome: 'platform_class',
      groups: [
        { key: 'ipad', students: 4, value: 200 },
        { key: 'mac', students: 0, value: null },
      ],
      disclaimer: 'correlation-not-causation',
    });
    const r2 = await svc.cohortCompare({ metric: 'daysActive', outcome: 'platform_class' });
    expect(r2.groups[0]).toEqual({ key: 'ipad', students: 4, value: 2.5 });
    expect(repo.answersByOutcome).not.toHaveBeenCalled();
    const w = sessionsByOutcome.mock.calls[0][0];
    expect(w.fromAt).toMatch(/00:00:00$/);
  });

  it('answerCount/accuracy 走答题侧；module 用 behavior_events 原生列，设备列由 repo 按学生近似', async () => {
    const answersByOutcome = vi.fn(async (_w: OpsWindow, _outcome: string) => [
      { key: 'mainline', students: 5, answered: 10, correct: 4 },
      { key: 'exam', students: 2, answered: 0, correct: 0 },
    ]);
    const { svc, repo } = svcWith({ answersByOutcome });
    const r = await svc.cohortCompare({ metric: 'accuracy', outcome: 'module' });
    expect(r.groups).toEqual([
      { key: 'mainline', students: 5, value: 0.4 },
      { key: 'exam', students: 2, value: null }, // answered=0 → null（不许写 0）
    ]);
    expect(r.disclaimer).toBe('correlation-not-causation');
    expect(answersByOutcome.mock.calls[0][1]).toBe('module');
    const r2 = await svc.cohortCompare({ metric: 'answerCount', outcome: 'platform_class' });
    expect(r2.groups[0]).toEqual({ key: 'mainline', students: 5, value: 2 });
    expect(answersByOutcome.mock.calls[1][1]).toBe('platform_class');
    expect(repo.sessionsByOutcome).not.toHaveBeenCalled();
  });
});

describe('OpsAnalyticsService.llmTokens（Task 11）', () => {
  it('groupBy 白名单越界 / 缺失 → 400/1001', async () => {
    const { svc } = svcWith({});
    await expect(svc.llmTokens({ groupBy: 'cost' as never })).rejects.toMatchObject({
      response: { code: 1001 },
    });
    await expect(svc.llmTokens({} as never)).rejects.toMatchObject({
      response: { code: 1001 },
    });
  });

  it('按 scene 聚合：unavailable 单列不当 0 求和（items[].unavailableCalls 与顶层 unavailableCalls 并存）', async () => {
    const llmTokenGroups = vi.fn(async () => [
      { key: 'tutoring', calls: 3, inputTokens: 100, outputTokens: 0, unavailableCalls: 1 },
    ]);
    const llmTokensOverview = vi.fn(async () => ({
      attributed: 2, unattributed: 1, unavailableCalls: 1,
    }));
    const { svc, repo } = svcWith({ llmTokenGroups, llmTokensOverview });
    const r = await svc.llmTokens({ groupBy: 'scene', from: '2026-10-01', to: '2026-10-07' });
    expect(r).toEqual({
      groupBy: 'scene',
      items: [{ key: 'tutoring', calls: 3, inputTokens: 100, outputTokens: 0, unavailableCalls: 1 }],
      attributed: 2,
      unattributed: 1,
      unavailableCalls: 1,
    });
    expect(repo.llmTokenGroups).toHaveBeenCalledTimes(1);
    expect(repo.llmTokensOverview).toHaveBeenCalledTimes(1);
    const w = (llmTokenGroups as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpsWindow;
    expect(w.fromAt).toBe('2026-10-01 00:00:00');
    expect(w.toAt).toBe('2026-10-08 00:00:00');
    expect((llmTokenGroups as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('scene');
  });

  it('groupBy=model 透传 repo（聚合按 model_key）；groupBy=day/student 同样透传', async () => {
    const llmTokenGroups = vi.fn(async () => []);
    const { svc } = svcWith({ llmTokenGroups });
    await svc.llmTokens({ groupBy: 'model' });
    await svc.llmTokens({ groupBy: 'day' });
    await svc.llmTokens({ groupBy: 'student' });
    const called = (llmTokenGroups as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(called).toEqual(['model', 'day', 'student']);
  });
});

describe('OpsAnalyticsService.quality（Task 11）', () => {
  it('组装形状；passageSkipRate 恒 null；窗口透传一次', async () => {
    const qualityApi = vi.fn(async () => ({ total: 100, failures: 8 }));
    const qualityErrorCodes = vi.fn(async () => [
      { code: 5000, count: 5 }, { code: 1001, count: 3 },
    ]);
    const qualityLlm = vi.fn(async () => ({ calls: 50, timeouts: 2, fallbacks: 3, attributed: 45 }));
    const contentQuality = vi.fn(async () => ({
      questionsWithoutStandardAnswer: 4, kpCovered: 90, kpTotal: 100, wordWrong: 30, wordTotal: 600,
    }));
    const { svc, repo } = svcWith({ qualityApi, qualityErrorCodes, qualityLlm, contentQuality });
    const r = await svc.quality({ from: '2026-10-03', to: '2026-10-09' });
    expect(r).toEqual({
      apiFailureRate: 0.08,
      errorCodeDistribution: [{ code: 5000, count: 5 }, { code: 1001, count: 3 }],
      llmTimeoutRate: 0.04,
      llmFallbackRate: 0.06,
      llmAttributionCoverage: 0.9,
      questionsWithoutStandardAnswer: 4,
      kpCoverage: { covered: 90, total: 100, rate: 0.9 },
      globalWordErrorRate: { wrong: 30, total: 600, rate: 0.05 },
      passageSkipRate: null,
    });
    expect(repo.qualityApi).toHaveBeenCalledTimes(1);
    expect(repo.contentQuality).toHaveBeenCalledTimes(1);
  });

  it('分母为 0 → 各 rate null（不许写 0），错误码分布空数组', async () => {
    const { svc } = svcWith({});
    const r = await svc.quality({});
    expect(r).toEqual({
      apiFailureRate: null,
      errorCodeDistribution: [],
      llmTimeoutRate: null,
      llmFallbackRate: null,
      llmAttributionCoverage: null,
      questionsWithoutStandardAnswer: 0,
      kpCoverage: { covered: 0, total: 0, rate: null },
      globalWordErrorRate: { wrong: 0, total: 0, rate: null },
      passageSkipRate: null,
    });
  });
});

describe('OpsAnalyticsService.llmCalls（Task 11）', () => {
  it('过滤与分页透传 repo；pageSize 20', async () => {
    const llmCallsPage = vi.fn(
      async (_q: LlmCallsPageFilter) => ({ rows: [{ id: 1 }] as unknown[], total: 41 }),
    );
    const { svc, repo } = svcWith({ llmCallsPage });
    const r = await svc.llmCalls({ scene: 'tutoring', model: 'qwen-max', success: 'false', page: '3' });
    expect(r).toEqual({ items: [{ id: 1 }], page: 3, pageSize: 20, total: 41 });
    expect(repo.llmCallsPage).toHaveBeenCalledTimes(1);
    expect(llmCallsPage.mock.calls[0][0]).toEqual({
      scene: 'tutoring', model: 'qwen-max', success: 0, offset: 40, limit: 20,
    });
  });

  it('success 缺省不过滤；page 缺省 1；非法 success / page → 400/1001', async () => {
    const llmCallsPage = vi.fn(async (_q: LlmCallsPageFilter) => ({ rows: [], total: 0 }));
    const { svc } = svcWith({ llmCallsPage });
    await svc.llmCalls({});
    expect(llmCallsPage.mock.calls[0][0]).toEqual({ offset: 0, limit: 20 });
    await expect(svc.llmCalls({ success: 'yes' })).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(svc.llmCalls({ page: '0' })).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(svc.llmCalls({ page: 'abc' })).rejects.toMatchObject({ response: { code: 1001 } });
  });
});

describe('OpsAnalyticsService.requests（Task 11）', () => {
  it('path(LIKE)/status/minLatency 与分页透传 repo', async () => {
    const requestsPage = vi.fn(
      async (_q: RequestsPageFilter) => ({ rows: [{ id: 2 }] as unknown[], total: 7 }),
    );
    const { svc, repo } = svcWith({ requestsPage });
    const r = await svc.requests({ path: '/api/practice', status: '500', minLatency: '1000', page: '2' });
    expect(r).toEqual({ items: [{ id: 2 }], page: 2, pageSize: 20, total: 7 });
    expect(repo.requestsPage).toHaveBeenCalledTimes(1);
    expect(requestsPage.mock.calls[0][0]).toEqual({
      path: '/api/practice', status: 500, minLatency: 1000, offset: 20, limit: 20,
    });
  });

  it('缺省不过滤；非法 status / minLatency / page → 400/1001', async () => {
    const requestsPage = vi.fn(async (_q: RequestsPageFilter) => ({ rows: [], total: 0 }));
    const { svc } = svcWith({ requestsPage });
    await svc.requests({});
    expect(requestsPage.mock.calls[0][0]).toEqual({ offset: 0, limit: 20 });
    await expect(svc.requests({ status: 'x' })).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(svc.requests({ minLatency: '-1' })).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(svc.requests({ page: '0' })).rejects.toMatchObject({ response: { code: 1001 } });
  });
});
