import { describe, expect, it, vi } from 'vitest';
import { OpsAnalyticsService, parseWindow } from './ops-analytics.service.js';
import type { OpsAnalyticsRepository } from './ops-analytics.repo.js';

function svcWith(overrides: Partial<Record<keyof OpsAnalyticsRepository, unknown>>) {
  const repo = {
    overviewSessions: vi.fn(async () => ({ dau: 3, students: 7, totalSeconds: 7200 })),
    answerTotals: vi.fn(async () => ({ answered: 4, correct: 2 })),
    moduleTop: vi.fn(async () => [{ module: 'mainline', students: 5, seconds: 6000 }]),
    modulesWindow: vi.fn(async () => [
      { module: 'mainline', students: 5, seconds: 6000, sessions: 9, answered: 4, correct: 1 },
      { module: 'exam', students: 2, seconds: 1200, sessions: 3, answered: 0, correct: 0 },
    ]),
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
