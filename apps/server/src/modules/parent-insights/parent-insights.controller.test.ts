import { describe, it, expect, vi } from 'vitest';
import { ParentInsightsController } from './parent-insights.controller.js';
import type { ParentService } from '../parent/parent.service.js';
import type { StudyTimeService } from './study-time.service.js';
import type { SpecialsService } from './specials.service.js';
import type { ParentMasteryService } from './parent-mastery.service.js';
import type { GoalsService } from './goals.service.js';
import type { ControlsService } from './controls.service.js';
import type { AlertsService } from './alerts.service.js';

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
  // 本批新增的第 10/11 参：行为管控 / 预警中心
  const controls = {
    get: vi.fn().mockResolvedValue({ alertAwayMinutes: 5, alertIdleMinutes: 15 }),
    update: vi.fn().mockResolvedValue({ alertAwayMinutes: 5, alertIdleMinutes: 15 }),
  } as unknown as ControlsService;
  const alerts = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    markRead: vi.fn().mockResolvedValue(undefined),
  } as unknown as AlertsService;
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
    controls,
    alerts,
  );
  return { controller, studyTime, specials, mastery, goals, controls, alerts };
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

describe('ParentInsightsController controls 端点（spec §4.1/§4.2）', () => {
  it('GET：归属校验先于取数', async () => {
    const order: string[] = [];
    const requireOwned = vi.fn().mockImplementation(async () => {
      order.push('ownership');
    });
    const { controller, controls } = makeController(requireOwned);
    (controls.get as any).mockImplementation(async () => {
      order.push('query');
      return { alertAwayMinutes: 5, alertIdleMinutes: 15 };
    });

    await controller.getControls(USER, 11);

    expect(order).toEqual(['ownership', 'query']);
    expect(requireOwned).toHaveBeenCalledWith(3, 11);
    expect(controls.get).toHaveBeenCalledWith(11);
  });

  it('PUT：越界 0 / 181 → 409（schema 层就拦下，不是 400）且不写库', async () => {
    const { controller, controls } = makeController(vi.fn().mockResolvedValue(undefined));

    await expect(controller.putControls(USER, 11, { alertAwayMinutes: 0 })).rejects.toMatchObject({
      status: 409,
      response: { code: 1001 },
    });
    await expect(controller.putControls(USER, 11, { alertIdleMinutes: 181 })).rejects.toMatchObject({
      status: 409,
      response: { code: 1001 },
    });

    expect(controls.update).not.toHaveBeenCalled();
  });

  it('PUT：body 不是对象 / 字段类型错 → 409 且不写库（不落到 500）', async () => {
    const { controller, controls } = makeController(vi.fn().mockResolvedValue(undefined));

    await expect(controller.putControls(USER, 11, null)).rejects.toMatchObject({ status: 409 });
    await expect(
      controller.putControls(USER, 11, { alertAwayMinutes: '5' }),
    ).rejects.toMatchObject({ status: 409 });

    expect(controls.update).not.toHaveBeenCalled();
  });

  it('PUT：合法 → 归属校验后把 patch 透传给 service', async () => {
    const { controller, controls } = makeController(vi.fn().mockResolvedValue(undefined));

    await controller.putControls(USER, 11, { alertAwayMinutes: 2, alertIdleMinutes: 30 });

    expect(controls.update).toHaveBeenCalledWith(11, { alertAwayMinutes: 2, alertIdleMinutes: 30 });
  });

  it('PUT：归属失败 → 不写库（403 不许泄漏存在性）', async () => {
    const { controller, controls } = makeController(vi.fn().mockRejectedValue(new Error('1005')));

    await expect(controller.putControls(USER, 11, { alertAwayMinutes: 2 })).rejects.toThrow();

    expect(controls.update).not.toHaveBeenCalled();
  });
});

describe('ParentInsightsController alerts 端点（spec §4.3/§4.4）', () => {
  it('GET：studentId 缺省 → 不校验归属；分页取默认值 page=1/pageSize=20', async () => {
    const requireOwned = vi.fn().mockResolvedValue(undefined);
    const { controller, alerts } = makeController(requireOwned);

    await controller.listAlerts(USER, undefined, undefined, undefined, undefined);

    expect(requireOwned).not.toHaveBeenCalled();
    expect(alerts.list).toHaveBeenCalledWith(3, { page: 1, pageSize: 20 });
  });

  it('GET：studentId 给了先校验归属；unreadOnly=1 视为真；pageSize 上界 50', async () => {
    const order: string[] = [];
    const requireOwned = vi.fn().mockImplementation(async () => {
      order.push('ownership');
    });
    const { controller, alerts } = makeController(requireOwned);
    (alerts.list as any).mockImplementation(async () => {
      order.push('query');
      return { items: [], total: 0, page: 2, pageSize: 50 };
    });

    await controller.listAlerts(USER, '11', '1', '2', '50');

    expect(order).toEqual(['ownership', 'query']);
    expect(requireOwned).toHaveBeenCalledWith(3, 11);
    expect(alerts.list).toHaveBeenCalledWith(3, {
      studentId: 11,
      unreadOnly: true,
      page: 2,
      pageSize: 50,
    });
  });

  it('GET：studentId 空串 → 等同「没传」（不校验归属、不带筛选），不得静默变成 studentId=1', async () => {
    const requireOwned = vi.fn().mockResolvedValue(undefined);
    const { controller, alerts } = makeController(requireOwned);

    await controller.listAlerts(USER, '', undefined, undefined, undefined);

    // 这条钉子防的是「借一个合法 id 当占位默认值」：`1` 是合法学生 id，
    // 若解析写成 parsePositiveInt(studentId, 'studentId', 1)，空串会变成「看 1 号孩子」
    expect(requireOwned).not.toHaveBeenCalled();
    expect(alerts.list).toHaveBeenCalledWith(3, { page: 1, pageSize: 20 });
  });

  it('GET：studentId 非数字 → 400（不取数、不校验归属）', async () => {
    const requireOwned = vi.fn().mockResolvedValue(undefined);
    const { controller, alerts } = makeController(requireOwned);

    await expect(
      controller.listAlerts(USER, 'abc', undefined, undefined, undefined),
    ).rejects.toMatchObject({ status: 400 });

    expect(requireOwned).not.toHaveBeenCalled();
    expect(alerts.list).not.toHaveBeenCalled();
  });

  it('GET：unreadOnly 只有 "1" 算真（"0"/缺省都不加筛选）', async () => {
    const { controller, alerts } = makeController(vi.fn().mockResolvedValue(undefined));

    await controller.listAlerts(USER, undefined, '0', undefined, undefined);

    expect(alerts.list).toHaveBeenCalledWith(3, { page: 1, pageSize: 20 });
  });

  it('GET：分页非法（page=0 / pageSize=51）→ 400 且不取数', async () => {
    const { controller, alerts } = makeController(vi.fn().mockResolvedValue(undefined));

    await expect(controller.listAlerts(USER, undefined, undefined, '0', undefined)).rejects.toMatchObject({
      status: 400,
    });
    await expect(controller.listAlerts(USER, undefined, undefined, undefined, '51')).rejects.toMatchObject({
      status: 400,
    });

    expect(alerts.list).not.toHaveBeenCalled();
  });

  it('GET：studentId 非本家长 → 403 且不取数', async () => {
    const { controller, alerts } = makeController(vi.fn().mockRejectedValue(new Error('1005')));

    await expect(controller.listAlerts(USER, '11', undefined, undefined, undefined)).rejects.toThrow();

    expect(alerts.list).not.toHaveBeenCalled();
  });

  it('PATCH read：alertId 原样下传（正整数校验在 service，故 409 而非 400）', async () => {
    const { controller, alerts } = makeController(vi.fn().mockResolvedValue(undefined));

    await expect(controller.markAlertRead(USER, '12')).resolves.toBeNull();

    expect(alerts.markRead).toHaveBeenCalledWith(3, '12');
  });
});
