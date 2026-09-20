import { describe, it, expect, vi } from 'vitest';
import { GoalsService, GOAL_TEMPLATES, SUBJECTS_BY_METRIC } from './goals.service.js';
import type { Subject } from '../../database/repositories/subjects.repo.js';

const subject = (id: number, code: string, name: string, sortOrder: number): Subject =>
  ({ id, code, name, gradeBands: ['junior'], iconUrl: null, sortOrder, isActive: true });

const MATH = subject(1, 'math', '数学', 1);
const CHINESE = subject(2, 'chinese', '语文', 2);
const ENGLISH = subject(3, 'english', '英语', 3);
const PHYSICS = subject(4, 'physics', '物理', 4); // 非 MVP → 不该出现

const mk = (overrides: Partial<Record<string, any>> = {}) => ({
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
  analyticsRepo: { getStudyTimeBySubjectOne: vi.fn().mockResolvedValue(0) },
  lessonRepo: { countInWindow: vi.fn().mockResolvedValue(0) },
  // 默认：progress 里只有数学
  progressRepo: { findSubjectIdsByStudent: vi.fn().mockResolvedValue([1]) },
  subjectsRepo: {
    findAll: vi.fn().mockResolvedValue([MATH, CHINESE, ENGLISH, PHYSICS]),
    findById: vi.fn(),
  },
  ...overrides,
});

/** 参数顺序与 GoalsService 构造函数一致（漏传会静默变 undefined，务必对齐）。 */
const mkSvc = (d = mk()) =>
  new GoalsService(
    d.goalsRepo as any,
    d.logsRepo as any,
    d.mainErrorRepo as any,
    d.analyticsRepo as any,
    d.lessonRepo as any,
    d.progressRepo as any,
    d.subjectsRepo as any,
  );

/** 目标行夹具（`GoalsRepository.findActiveByStudent` 的返回形状）。 */
const goalRow = (subjectId: number | null, metric: string | null, target: number, title = 'T') =>
  ({ id: 1, subjectId, metric, period: 'daily', targetValue: target, title });

describe('GoalsService 在学学科解析', () => {
  it('在学学科 = progress 行 ∪ 兜底{语文,英语} ∩ MVP 白名单；数学只配数学也有专项目标位', async () => {
    const d = mk();
    await mkSvc(d).getAttainment(7);

    const defaults = d.goalsRepo.ensureDefaults.mock.calls[0][1] as any[];
    const bySubject = new Map<number, string[]>();
    for (const x of defaults) {
      bySubject.set(x.subjectId, [...(bySubject.get(x.subjectId) ?? []), x.metric]);
    }
    // 数学（progress）+ 语文/英语（兜底）；物理在 subjects 表里但不在白名单 → 不建
    expect([...bySubject.keys()].sort()).toEqual([1, 2, 3]);
    expect(bySubject.get(1)).toEqual(['daily_study_minutes', 'weekly_lessons', 'weekly_clear_errors']);
    expect(bySubject.get(2)).toContain('weekly_passages');
    expect(bySubject.get(2)).not.toContain('daily_words');
    expect(bySubject.get(3)).toContain('daily_words');
    expect(bySubject.get(3)).not.toContain('weekly_passages');
    // 3 + 4 + 4 = 11 行（计划里定下的默认规模）
    expect(defaults).toHaveLength(11);
  });

  it('没有任何在学学科 → **不建默认目标**、items 为空（绝不编造）', async () => {
    const d = mk({
      progressRepo: { findSubjectIdsByStudent: vi.fn().mockResolvedValue([]) },
      subjectsRepo: { findAll: vi.fn().mockResolvedValue([PHYSICS]), findById: vi.fn() },
    });

    const out = await mkSvc(d).getAttainment(7);

    expect(out.items).toEqual([]);
    expect(d.goalsRepo.ensureDefaults).not.toHaveBeenCalled();
  });

  it('isLearningSubject：在学学科内 true、白名单外 false（controller 的校验依据）', async () => {
    const d = mk();
    const svc = mkSvc(d);

    expect(await svc.isLearningSubject(7, 1)).toBe(true);  // 数学（progress 行）
    expect(await svc.isLearningSubject(7, 2)).toBe(true);  // 语文（兜底）
    expect(await svc.isLearningSubject(7, 4)).toBe(false); // 物理（非 MVP）
  });
});

describe('GoalsService 达成值分派（按学科）', () => {
  it('五个指标各走自己的数据源，且时长/完课/清零都带 subjectId', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow(1, 'daily_study_minutes', 30),
      goalRow(1, 'weekly_lessons', 2),
      goalRow(2, 'weekly_passages', 8),
      goalRow(3, 'daily_words', 20),
      goalRow(1, 'weekly_clear_errors', 5),
    ]);
    d.analyticsRepo.getStudyTimeBySubjectOne.mockResolvedValue(3599); // 59 分 59 秒 → 向下取整 59
    d.lessonRepo.countInWindow.mockResolvedValue(3);
    d.logsRepo.countDistinctPassages.mockResolvedValue(4);
    d.logsRepo.aggregateByModule.mockResolvedValue([
      { module: 'en_vocabulary', units: 7, answered: 7, correct: 5 },
    ]);
    d.mainErrorRepo.countClearedBetween.mockResolvedValue(2);

    const out = await mkSvc(d).getAttainment(7);
    const achieved = Object.fromEntries(
      out.items.map((i) => [`${i.subjectId}:${i.metric}`, i.achieved]),
    );

    expect(achieved).toEqual({
      '1:daily_study_minutes': 59,
      '1:weekly_lessons': 3,
      '2:weekly_passages': 4,
      '3:daily_words': 7,
      '1:weekly_clear_errors': 2,
    });
    // 时长 / 完课 / 清零：必须按学科（调用参数里第二个就是 subjectId）
    expect(d.analyticsRepo.getStudyTimeBySubjectOne.mock.calls[0][1]).toBe(1);
    expect(d.lessonRepo.countInWindow.mock.calls[0][1]).toBe(1);
    expect(d.mainErrorRepo.countClearedBetween.mock.calls[0][1]).toBe(1);
  });

  it('同一个 metric 出现在两个学科 → 两条 items，各自算各自的达成值', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow(1, 'daily_study_minutes', 30),
      goalRow(2, 'daily_study_minutes', 30),
    ]);
    d.analyticsRepo.getStudyTimeBySubjectOne.mockImplementation(
      async (_studentId: number, subjectId: number) => (subjectId === 1 ? 60 * 20 : 60 * 5),
    );

    const out = await mkSvc(d).getAttainment(7);

    expect(out.items.map((i) => `${i.subjectId}=${i.achieved}`)).toEqual(['1=20', '2=5']);
    expect(d.analyticsRepo.getStudyTimeBySubjectOne).toHaveBeenCalledTimes(2);
  });

  it('rate 复用 toRate（分母 = target）：达标 100、超额 >100、target=0 → null', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow(1, 'weekly_lessons', 2),
      goalRow(2, 'weekly_lessons', 0),
    ]);
    d.lessonRepo.countInWindow.mockResolvedValue(5);

    const out = await mkSvc(d).getAttainment(7);

    expect(out.items.find((i) => i.subjectId === 1)?.rate).toBe(250);
    expect(out.items.find((i) => i.subjectId === 2)?.rate).toBeNull();
  });

  it('窗口：daily = 今天、weekly = 近 7 天（半开区间、本地 00:00、不用 CURDATE）', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow(1, 'daily_study_minutes', 30),
      goalRow(1, 'weekly_lessons', 2),
    ]);

    await mkSvc(d).getAttainment(7);

    const DAY = 24 * 3_600_000;
    const [, , dailyFrom, dailyTo] = d.analyticsRepo.getStudyTimeBySubjectOne.mock.calls[0] as [
      number, number, Date, Date,
    ];
    const [, , weekFrom, weekTo] = d.lessonRepo.countInWindow.mock.calls[0] as [
      number, number, Date, Date,
    ];
    expect(dailyTo.getTime() - dailyFrom.getTime()).toBe(DAY);
    expect(weekTo.getTime() - weekFrom.getTime()).toBe(7 * DAY);
    expect(dailyFrom.getHours()).toBe(0);
    expect(weekFrom.getHours()).toBe(0);
  });
});

describe('GoalsService 排序与脏数据', () => {
  it('排序：学科按 sort_order、指标按模板声明顺序（不随 id 漂移）', async () => {
    const d = mk();
    // 故意乱序返回：英语在前、数学在后
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow(3, 'daily_words', 20),
      goalRow(1, 'weekly_clear_errors', 5),
      goalRow(1, 'daily_study_minutes', 30),
      goalRow(2, 'weekly_passages', 8),
    ]);

    const out = await mkSvc(d).getAttainment(7);

    expect(out.items.map((i) => `${i.subjectId}:${i.metric}`)).toEqual([
      '1:daily_study_minutes', // 数学：模板顺序里时长在清零之前
      '1:weekly_clear_errors',
      '2:weekly_passages',     // 语文 sort_order = 2
      '3:daily_words',         // 英语 sort_order = 3
    ]);
  });

  it('metric/subjectId 为 NULL 的历史停用行、以及不在在学学科的行都不进响应', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow(1, 'daily_study_minutes', 30),
      goalRow(null, 'daily_words', 20),       // 迁移前遗留：无学科
      goalRow(1, null, 1),                    // 迁移前遗留：无指标
      goalRow(4, 'daily_study_minutes', 30),  // 物理：非 MVP，不在在学学科
    ]);

    const out = await mkSvc(d).getAttainment(7);

    expect(out.items.map((i) => i.metric)).toEqual(['daily_study_minutes']);
  });
});

describe('GoalsService.upsertTarget', () => {
  it('period/title 由 metric 派生（不接受家长自定义），回填学科名与达成值', async () => {
    const d = mk();
    d.subjectsRepo.findById.mockResolvedValue(ENGLISH);
    d.logsRepo.aggregateByModule.mockResolvedValue([
      { module: 'en_vocabulary', units: 12, answered: 0, correct: 0 },
    ]);

    const out = await mkSvc(d).upsertTarget(7, 3, 'daily_words', 24);

    expect(d.goalsRepo.upsertTarget).toHaveBeenCalledWith(
      7, 3, 'daily_words', 'daily', '每日背单词', 24,
    );
    expect(out).toMatchObject({
      metric: 'daily_words', subjectId: 3, subjectName: '英语',
      period: 'daily', target: 24, achieved: 12, rate: 50,
    });
  });
});

describe('GoalsService 模板一致性（防漂移）', () => {
  it('SUBJECTS_BY_METRIC 与 GOAL_TEMPLATES 同源，且每个 metric 恰好一个模板', () => {
    for (const t of GOAL_TEMPLATES) {
      expect(SUBJECTS_BY_METRIC[t.metric]).toBe(t.subjects);
    }
    expect(GOAL_TEMPLATES.map((t) => t.metric).sort()).toEqual(
      Object.keys(SUBJECTS_BY_METRIC).sort(),
    );
    // 新增 metric 时最容易漏的是 controller 的 GOAL_METRICS 白名单（那边有用例钉着）
    expect(GOAL_TEMPLATES).toHaveLength(5);
  });
});
