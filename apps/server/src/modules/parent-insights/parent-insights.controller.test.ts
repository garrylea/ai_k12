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

    await expect(controller.putGoalTarget(USER, 11, 'daily_x', { target: 30 }))
      .rejects.toMatchObject({ status: 400 });
    await expect(controller.putGoalTarget(USER, 11, 'daily_words', { target: 0 }))
      .rejects.toMatchObject({ status: 400 });
    await expect(controller.putGoalTarget(USER, 11, 'daily_words', { target: 20.5 }))
      .rejects.toMatchObject({ status: 400 });
    await expect(controller.putGoalTarget(USER, 11, 'daily_words', {}))
      .rejects.toMatchObject({ status: 400 });
    expect(goals.upsertTarget).not.toHaveBeenCalled();
  });

  it('PUT goals/:metric：合法入参 → 调 service（period/title 由服务端派生）', async () => {
    const { controller, goals } = makeController(vi.fn().mockImplementation(async () => {}));

    await controller.putGoalTarget(USER, 11, 'daily_words', { target: 30 });

    expect(goals.upsertTarget).toHaveBeenCalledWith(11, 'daily_words', 30);
  });

  it('归属校验失败时不写库（403 不许泄漏存在性）', async () => {
    const { controller, goals } = makeController(vi.fn().mockRejectedValue(new Error('1005')));

    await expect(controller.putGoalTarget(USER, 11, 'daily_words', { target: 30 })).rejects.toThrow();
    expect(goals.upsertTarget).not.toHaveBeenCalled();
  });
});
