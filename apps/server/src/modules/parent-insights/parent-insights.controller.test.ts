import { describe, it, expect, vi } from 'vitest';
import { ParentInsightsController } from './parent-insights.controller.js';
import type { ParentService } from '../parent/parent.service.js';
import type { StudyTimeService } from './study-time.service.js';
import type { SpecialsService } from './specials.service.js';
import type { ParentMasteryService } from './parent-mastery.service.js';
import type { GoalsService } from './goals.service.js';

function makeController(requireOwnedStudent: ReturnType<typeof vi.fn>) {
  const parentService = { requireOwnedStudent } as unknown as ParentService;
  const studyTime = {
    getStudyTime: vi.fn().mockResolvedValue({ totalSeconds: 0 }),
    getTodayUsage: vi.fn().mockResolvedValue({ activeSeconds: 0 }),
  } as unknown as StudyTimeService;
  // 埋点 Phase 1B 新增的第 7/8/9 参（位置参数，必须按顺序补齐）
  const specials = { getSpecials: vi.fn().mockResolvedValue({}) } as unknown as SpecialsService;
  const mastery = { getMastery: vi.fn().mockResolvedValue({}) } as unknown as ParentMasteryService;
  const goals = {
    getAttainment: vi.fn().mockResolvedValue({ items: [] }),
    upsertTarget: vi.fn().mockResolvedValue({}),
    // P6.5：controller 用这两个做「指标×学科」与「在学学科」校验，默认放行
    isMetricAllowedForSubject: vi.fn().mockResolvedValue(true),
    isLearningSubject: vi.fn().mockResolvedValue(true),
  } as unknown as GoalsService;
  const controller = new ParentInsightsController(
    parentService,
    {} as never, // dashboardService
    {} as never, // reportService
    {} as never, // errorsService
    {} as never, // chatLogsService
    studyTime,
    specials,
    mastery,
    goals,
  );
  return { controller, studyTime, specials, mastery, goals };
}

const USER = { sub: 3, role: 'parent' as const };

describe('ParentInsightsController 学习时长端点', () => {
  it('study-time 先做归属校验，再取数', async () => {
    const order: string[] = [];
    const requireOwned = vi.fn().mockImplementation(async () => {
      order.push('ownership');
    });
    const { controller, studyTime } = makeController(requireOwned);
    (studyTime.getStudyTime as any).mockImplementation(async () => {
      order.push('query');
      return { totalSeconds: 0 };
    });

    await controller.getStudyTime(USER, 11, '2026-09-13', '2026-09-19');
    expect(order).toEqual(['ownership', 'query']);
    expect(requireOwned).toHaveBeenCalledWith(3, 11);
    expect(studyTime.getStudyTime).toHaveBeenCalledWith(11, '2026-09-13', '2026-09-19');
  });

  it('归属校验失败时**不取数**（1005 不许泄漏存在性）', async () => {
    const requireOwned = vi.fn().mockRejectedValue(new Error('1005'));
    const { controller, studyTime } = makeController(requireOwned);
    await expect(controller.getTodayUsage(USER, 11)).rejects.toThrow();
    expect(studyTime.getTodayUsage).not.toHaveBeenCalled();
  });
});

describe('ParentInsightsController 专项 / 掌握度 / 目标端点（埋点 Phase 1B）', () => {
  it('specials：归属校验先于取数，from/to 原样透传', async () => {
    const order: string[] = [];
    const requireOwned = vi.fn().mockImplementation(async () => {
      order.push('ownership');
    });
    const { controller, specials } = makeController(requireOwned);
    (specials.getSpecials as any).mockImplementation(async () => {
      order.push('query');
      return {};
    });

    await controller.getSpecials(USER, 11, '2026-09-13', '2026-09-19');

    expect(order).toEqual(['ownership', 'query']);
    expect(requireOwned).toHaveBeenCalledWith(3, 11);
    expect(specials.getSpecials).toHaveBeenCalledWith(11, '2026-09-13', '2026-09-19');
  });

  it('mastery：limit 缺省 10；越界/非法一律 400 且**不取数**', async () => {
    const requireOwned = vi.fn().mockImplementation(async () => {});
    const { controller, mastery } = makeController(requireOwned);

    await controller.getMastery(USER, 11, undefined);
    expect(mastery.getMastery).toHaveBeenCalledWith(11, 10);

    await expect(controller.getMastery(USER, 11, '51')).rejects.toMatchObject({ status: 400 });
    await expect(controller.getMastery(USER, 11, '0')).rejects.toMatchObject({ status: 400 });
    await expect(controller.getMastery(USER, 11, 'abc')).rejects.toMatchObject({ status: 400 });
    expect(mastery.getMastery).toHaveBeenCalledTimes(1); // 只有缺省那次真取数
  });

  it('goals/attainment：归属校验后取达成', async () => {
    const requireOwned = vi.fn().mockImplementation(async () => {});
    const { controller, goals } = makeController(requireOwned);

    await controller.getGoalAttainment(USER, 11);

    expect(requireOwned).toHaveBeenCalledWith(3, 11);
    expect(goals.getAttainment).toHaveBeenCalledWith(11);
  });

  it('PUT goals/:metric：白名单外 400、body 非法 400，都不写库', async () => {
    const { controller, goals } = makeController(vi.fn().mockImplementation(async () => {}));

    await expect(controller.putGoalTarget(USER, 11, 'daily_x', { target: 30, subjectId: 1 }))
      .rejects.toMatchObject({ status: 400 });
    await expect(controller.putGoalTarget(USER, 11, 'daily_words', { target: 0, subjectId: 3 }))
      .rejects.toMatchObject({ status: 400 });
    await expect(controller.putGoalTarget(USER, 11, 'daily_words', { target: 20.5, subjectId: 3 }))
      .rejects.toMatchObject({ status: 400 });
    await expect(controller.putGoalTarget(USER, 11, 'daily_words', { target: 30 }))
      .rejects.toMatchObject({ status: 400 });
    await expect(controller.putGoalTarget(USER, 11, 'daily_words', { target: 30, subjectId: 0 }))
      .rejects.toMatchObject({ status: 400 });
    expect(goals.upsertTarget).not.toHaveBeenCalled();
  });

  it('PUT goals/:metric：指标与学科不匹配 → 400 且不写库（如「每日背单词」只适用英语）', async () => {
    const { controller, goals } = makeController(vi.fn().mockImplementation(async () => {}));
    (goals.isMetricAllowedForSubject as any).mockResolvedValue(false); // 英语专属指标配到了数学

    await expect(controller.putGoalTarget(USER, 11, 'daily_words', { target: 30, subjectId: 1 }))
      .rejects.toMatchObject({ status: 400 });

    expect(goals.isMetricAllowedForSubject).toHaveBeenCalledWith(1, 'daily_words');
    // 第一步就被拦下：连「在学学科」都不必查，更不能写库
    expect(goals.isLearningSubject).not.toHaveBeenCalled();
    expect(goals.upsertTarget).not.toHaveBeenCalled();
  });

  it('PUT goals/:metric：不是该生的在学学科 → 400 且不写库', async () => {
    const { controller, goals } = makeController(vi.fn().mockImplementation(async () => {}));
    (goals.isLearningSubject as any).mockResolvedValue(false);

    await expect(controller.putGoalTarget(USER, 11, 'weekly_lessons', { target: 2, subjectId: 4 }))
      .rejects.toMatchObject({ status: 400 });

    expect(goals.isLearningSubject).toHaveBeenCalledWith(11, 4);
    expect(goals.upsertTarget).not.toHaveBeenCalled();
  });

  it('PUT goals/:metric：合法入参 → 调 service，subjectId 一并传入', async () => {
    const { controller, goals } = makeController(vi.fn().mockImplementation(async () => {}));

    await controller.putGoalTarget(USER, 11, 'daily_words', { target: 30, subjectId: 3 });

    expect(goals.upsertTarget).toHaveBeenCalledWith(11, 3, 'daily_words', 30);
  });

  it('PUT goals/:metric：`weekly_lessons` 是合法指标（新增指标别漏进白名单）', async () => {
    const { controller, goals } = makeController(vi.fn().mockImplementation(async () => {}));

    await controller.putGoalTarget(USER, 11, 'weekly_lessons', { target: 2, subjectId: 1 });

    expect(goals.upsertTarget).toHaveBeenCalledWith(11, 1, 'weekly_lessons', 2);
  });

  it('归属校验失败时不写库（403 不许泄漏存在性）', async () => {
    const { controller, goals } = makeController(vi.fn().mockRejectedValue(new Error('1005')));

    await expect(
      controller.putGoalTarget(USER, 11, 'daily_words', { target: 30, subjectId: 3 }),
    ).rejects.toThrow();
    expect(goals.upsertTarget).not.toHaveBeenCalled();
  });
});
