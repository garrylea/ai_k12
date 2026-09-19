import { describe, it, expect, vi } from 'vitest';
import { GoalsService, GOAL_DEFAULTS } from './goals.service.js';

const mk = () => ({
  goalsRepo: {
    ensureDefaults: vi.fn().mockResolvedValue(undefined),
    findActiveByStudent: vi.fn().mockResolvedValue([]),
    upsertTarget: vi.fn().mockResolvedValue(undefined),
  },
  logsRepo: {
    aggregateByModule: vi.fn().mockResolvedValue([]),
    countDistinctPassages: vi.fn().mockResolvedValue(0),
  },
  mainErrorRepo: { countClearedBetween: vi.fn().mockResolvedValue(0) },
  analyticsRepo: { getStudyTimeTotal: vi.fn().mockResolvedValue(0) },
});
const mkSvc = (d = mk()) =>
  new GoalsService(d.goalsRepo as any, d.logsRepo as any, d.mainErrorRepo as any, d.analyticsRepo as any);

const goalRow = (metric: string, target: number, title = 'T') =>
  ({ id: 1, metric, period: 'daily', targetValue: target, title });

describe('GoalsService.getAttainment', () => {
  it('先懒初始化（只补缺失），再读启用中的目标', async () => {
    const d = mk();
    await mkSvc(d).getAttainment(11);
    expect(d.goalsRepo.ensureDefaults).toHaveBeenCalledWith(11, GOAL_DEFAULTS);
    expect(d.goalsRepo.findActiveByStudent).toHaveBeenCalledWith(11);
  });

  it('四个 metric 的达成值各走自己的数据源', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow('daily_study_minutes', 60), goalRow('daily_words', 20),
      goalRow('weekly_passages', 8), goalRow('weekly_clear_errors', 10),
    ]);
    d.analyticsRepo.getStudyTimeTotal.mockResolvedValue(3599); // 59 分 59 秒 → 向下取整 59
    d.logsRepo.aggregateByModule.mockResolvedValue([
      { module: 'en_vocabulary', units: 7, answered: 7, correct: 5 },
    ]);
    d.logsRepo.countDistinctPassages.mockResolvedValue(3);
    d.mainErrorRepo.countClearedBetween.mockResolvedValue(4);

    const out = await mkSvc(d).getAttainment(11);

    expect(Object.fromEntries(out.items.map((i) => [i.metric, i.achieved]))).toEqual({
      daily_study_minutes: 59, daily_words: 7, weekly_passages: 3, weekly_clear_errors: 4,
    });
  });

  it('rate 复用 toRate（分母 = target）：达标 100、超额可 >100、target=0 → null', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow('daily_words', 10), goalRow('weekly_clear_errors', 0),
    ]);
    d.logsRepo.aggregateByModule.mockResolvedValue([
      { module: 'en_vocabulary', units: 15, answered: 0, correct: 0 },
    ]);

    const out = await mkSvc(d).getAttainment(11);

    expect(out.items.find((i) => i.metric === 'daily_words')?.rate).toBe(150);
    expect(out.items.find((i) => i.metric === 'weekly_clear_errors')?.rate).toBeNull();
  });

  it('daily 用今天窗口、weekly 用近 7 天窗口（半开区间，绝不用 CURDATE）', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow('daily_study_minutes', 60), goalRow('weekly_passages', 8),
    ]);
    await mkSvc(d).getAttainment(11);

    // 注意：mock 的入参是 (studentId, from, toExclusive)，第一个元素要跳过
    const [, dailyFrom, dailyTo] = d.analyticsRepo.getStudyTimeTotal.mock.calls[0] as [number, Date, Date];
    const [, weekFrom, weekTo] = d.logsRepo.countDistinctPassages.mock.calls[0] as [number, Date, Date];
    const DAY = 24 * 3_600_000;
    expect(dailyTo.getTime() - dailyFrom.getTime()).toBe(DAY);
    expect(weekTo.getTime() - weekFrom.getTime()).toBe(7 * DAY);
    expect(dailyFrom.getHours()).toBe(0); // 本地 00:00
    expect(weekFrom.getHours()).toBe(0);
  });

  it('metric 为 NULL 的历史脏行不进响应（前端按 metric 渲染）', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow('daily_words', 20), { ...goalRow('x', 1), metric: null },
    ]);
    const out = await mkSvc(d).getAttainment(11);
    expect(out.items.map((i) => i.metric)).toEqual(['daily_words']);
  });

  it('返回顺序固定按 GOAL_DEFAULTS，不随 id 漂移', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow('weekly_clear_errors', 10), goalRow('daily_words', 20), goalRow('daily_study_minutes', 60),
    ]);
    const out = await mkSvc(d).getAttainment(11);
    expect(out.items.map((i) => i.metric)).toEqual([
      'daily_study_minutes', 'daily_words', 'weekly_clear_errors',
    ]);
  });
});

describe('GoalsService.upsertTarget', () => {
  it('period/title 由 metric 派生（不接受家长自定义），并回填达成值', async () => {
    const d = mk();
    d.logsRepo.aggregateByModule.mockResolvedValue([
      { module: 'en_vocabulary', units: 12, answered: 0, correct: 0 },
    ]);

    const out = await mkSvc(d).upsertTarget(11, 'daily_words', 24);

    expect(d.goalsRepo.upsertTarget).toHaveBeenCalledWith(11, 'daily_words', 'daily', '每日背单词', 24);
    expect(out).toMatchObject({ metric: 'daily_words', period: 'daily', target: 24, achieved: 12, rate: 50 });
  });

  it('weekly 维度 → period=weekly', async () => {
    const d = mk();
    await mkSvc(d).upsertTarget(11, 'weekly_passages', 6);
    expect(d.goalsRepo.upsertTarget).toHaveBeenCalledWith(11, 'weekly_passages', 'weekly', '每周古诗文篇目', 6);
  });
});
