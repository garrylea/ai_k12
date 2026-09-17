import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PointsController } from './points.controller.js';
import { PointsService } from './points.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import type { PointRulesService, PointRuleTierView } from './point-rules.service.js';
import type { RedemptionService } from './redemption.service.js';

/**
 * Nest 的 `GUARDS_METADATA` 常量值。`@nestjs/common` 没把它从包入口导出
 * （内部在 `@nestjs/common/constants`），这里用字面量 + 用例钉住，防装饰器被误删。
 */
const GUARDS_METADATA = '__guards__';

const STUDENT = { sub: 7, role: 'student' } as const;
const PARENT = { sub: 9, role: 'parent' } as const;

/** 造一个只够 `JwtAuthGuard` / `RolesGuard` 用的 `ExecutionContext`。 */
function mkCtx(user: unknown, handler: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => PointsController,
  } as unknown as ExecutionContext;
}

function tier(over: Partial<PointRuleTierView> = {}): PointRuleTierView {
  return {
    tierKey: 'default',
    tierLabel: '一课',
    points: 10,
    dailyLimit: null,
    isActive: true,
    completedToday: null,
    remainingToday: null,
    ...over,
  };
}

/** vitest mock 函数类型；用 `ReturnType` 取，省得手写 vitest 的泛型参数。 */
type MockFn = ReturnType<typeof vi.fn>;

/** 造一个 controller：三个 service 全是 mock，不连库。 */
function makeController(over: {
  points?: { getOverview?: MockFn; getLedger?: MockFn };
  rules?: { listGrouped?: MockFn };
  redemption?: { listForStudent?: MockFn };
} = {}) {
  const points = { getOverview: vi.fn(), getLedger: vi.fn(), ...over.points };
  const rules = { listGrouped: vi.fn(), ...over.rules };
  const redemption = { listForStudent: vi.fn(), ...over.redemption };
  const controller = new PointsController(
    points as unknown as PointsService,
    rules as unknown as PointRulesService,
    redemption as unknown as RedemptionService,
  );
  return { controller, points, rules, redemption };
}

/**
 * 用**真** `PointsService` + 假仓储跑概览端点——段位/进度必须来自 `levels.ts`
 * （在 controller 里重算阈值是本次改动最容易犯的错，那样这个用例就会红）。
 */
function makeRealController(
  snapshot: { totalEarned: number; balance: number },
  todayEarned: number,
  ledgerRows: unknown[] = [],
) {
  const ledgerRepo = {
    sumTodayEarned: vi.fn().mockResolvedValue(todayEarned),
    listByStudent: vi.fn().mockResolvedValue(ledgerRows),
    countByStudent: vi.fn().mockResolvedValue(ledgerRows.length),
  };
  const pointsRepo = { find: vi.fn().mockResolvedValue(snapshot) };
  const service = new PointsService(
    {} as never, // getOverview / getLedger 不碰 pool（只有 award 的事务需要）
    {} as never,
    ledgerRepo as never,
    pointsRepo as never,
    // 固定时钟：本地时区 2026-09-17 10:00
    () => new Date(2026, 8, 17, 10, 0, 0),
  );
  const rules = { listGrouped: vi.fn() };
  const redemption = { listForStudent: vi.fn() };
  const controller = new PointsController(
    service,
    rules as unknown as PointRulesService,
    redemption as unknown as RedemptionService,
  );
  return { controller, service, ledgerRepo, pointsRepo };
}

describe('PointsController 守卫', () => {
  const jwtGuard = new JwtAuthGuard();
  const rolesGuard = new RolesGuard(new Reflector());

  // 按 Nest 的注册顺序依次跑：先 JwtAuthGuard（无 token → 401），再 RolesGuard（角色不符 → 403）
  const run = (user: unknown) => {
    const context = mkCtx(user, PointsController.prototype.getMe);
    jwtGuard.canActivate(context);
    rolesGuard.canActivate(context);
  };

  it('类上挂了 JwtAuthGuard + RolesGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, PointsController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));
  });

  it('类上标了 @Roles("student")，家长 token → 403', () => {
    expect(() => run(PARENT)).toThrow(ForbiddenException);
  });

  it('无 token → 401', () => {
    expect(() => run(undefined)).toThrow(UnauthorizedException);
  });

  it('学生 token → 放行', () => {
    expect(() => run(STUDENT)).not.toThrow();
  });
});

describe('PointsController.getMe', () => {
  it('用 JWT 里的 studentId 调 service（不接受任何客户端入参）', async () => {
    const { controller, points } = makeController();
    const overview = { balance: 1, totalEarned: 2, todayEarned: 3 };
    points.getOverview.mockResolvedValue(overview);

    await expect(controller.getMe(STUDENT)).resolves.toBe(overview);
    expect(points.getOverview).toHaveBeenCalledWith(7);
  });

  it('从未发过分的全新学生：全 0 + 劈柴，返回 200 而非 404', async () => {
    const { controller } = makeRealController({ totalEarned: 0, balance: 0 }, 0);

    await expect(controller.getMe(STUDENT)).resolves.toEqual({
      balance: 0,
      totalEarned: 0,
      todayEarned: 0,
      level: { code: 'pichai', name: '劈柴', index: 0, threshold: 0 },
      nextLevel: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
      pointsToNextLevel: 500,
      progressPercent: 0,
    });
  });

  it('todayEarned 取当天 earn 求和，日界用本地时区 00:00 传参', async () => {
    const { controller, ledgerRepo } = makeRealController({ totalEarned: 1200, balance: 900 }, 12);

    const overview = await controller.getMe(STUDENT);

    expect(overview.todayEarned).toBe(12);
    const [studentId, dayStart, dayEnd] = ledgerRepo.sumTodayEarned.mock.calls[0];
    expect(studentId).toBe(7);
    // 半开区间：今天 00:00 <= created_at < 明天 00:00（不用 SQL 的 CURDATE()）
    expect(dayStart).toEqual(new Date(2026, 8, 17, 0, 0, 0, 0));
    expect(dayEnd).toEqual(new Date(2026, 8, 18, 0, 0, 0, 0));
  });

  it('满级（王者）：nextLevel / pointsToNextLevel 为 null，进度 100', async () => {
    const { controller } = makeRealController({ totalEarned: 20000, balance: 12345 }, 0);

    const overview = await controller.getMe(STUDENT);

    expect(overview.level.code).toBe('wangzhe');
    expect(overview.nextLevel).toBeNull();
    expect(overview.pointsToNextLevel).toBeNull();
    expect(overview.progressPercent).toBe(100);
  });
});

describe('PointsController.getMyLedger', () => {
  it('不传分页参数 → page=1 / pageSize=20', async () => {
    const { controller, points } = makeController();
    points.getLedger.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await controller.getMyLedger(STUDENT, undefined, undefined);

    expect(points.getLedger).toHaveBeenCalledWith(7, 1, 20);
  });

  it('合法值原样透传；pageSize=100 是允许的上界', async () => {
    const { controller, points } = makeController();
    points.getLedger.mockResolvedValue({ items: [], total: 0, page: 2, pageSize: 100 });

    await controller.getMyLedger(STUDENT, '2', '100');

    expect(points.getLedger).toHaveBeenCalledWith(7, 2, 100);
  });

  it('空串按「未传」处理（取默认值）', async () => {
    const { controller, points } = makeController();
    points.getLedger.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await controller.getMyLedger(STUDENT, '', '');

    expect(points.getLedger).toHaveBeenCalledWith(7, 1, 20);
  });

  it('items 只挑展示字段（行内字段不下发），offset 由 page/pageSize 换算', async () => {
    const createdAt = new Date(2026, 8, 17, 9, 0, 0);
    const row = {
      id: 12,
      student_id: 7,
      kind: 'earn',
      task_code: 'en_vocabulary',
      tier_key: '10',
      points: 2,
      dedupe_key: 'vsess:9',
      title: '英语背单词 · 10 词',
      ref_type: 'session',
      ref_id: 9,
      redemption_id: null,
      created_at: createdAt,
    };
    const { controller, ledgerRepo } = makeRealController({ totalEarned: 0, balance: 0 }, 0, [row]);

    const page = await controller.getMyLedger(STUDENT, '2', '10');

    expect(ledgerRepo.listByStudent).toHaveBeenCalledWith(7, 10, 10);
    expect(page).toEqual({
      items: [
        { id: 12, kind: 'earn', title: '英语背单词 · 10 词', points: 2, createdAt, refType: 'session' },
      ],
      total: 1,
      page: 2,
      pageSize: 10,
    });
    // 内部字段（student_id / dedupe_key / task_code / redemption_id…）一律不下发
    expect(Object.keys(page.items[0])).toEqual(['id', 'kind', 'title', 'points', 'createdAt', 'refType']);
  });

  it('越界/非法值一律 400，不静默钳制', async () => {
    const { controller, points } = makeController();

    const bad: Array<[string, string]> = [
      ['1', '0'],      // pageSize 下界
      ['1', '101'],    // pageSize 上界
      ['1', '20.5'],   // 非整数
      ['1', 'abc'],    // 非数字
      ['abc', '20'],   // page 非数字
      ['0', '20'],     // page 下界
      ['-1', '20'],    // page 负数
      ['1', '-20'],    // pageSize 负数
      ['99999999999999999999', '20'], // 超出 safe integer：offset 会变成 1e21 直送 LIMIT
    ];
    for (const [page, pageSize] of bad) {
      await expect(controller.getMyLedger(STUDENT, page, pageSize)).rejects.toThrow(
        BadRequestException,
      );
    }
    expect(points.getLedger).not.toHaveBeenCalled();
  });
});

describe('PointsController.getMyRules', () => {
  it('只返回 isActive 档位：下架档位不出现在学生可选项里', async () => {
    const { controller, rules } = makeController();
    rules.listGrouped.mockResolvedValue({
      tasks: [
        {
          taskCode: 'math_targeted',
          taskName: '数学专项',
          tiers: [
            tier({ tierKey: '3', tierLabel: '3 题', points: 8, dailyLimit: 2, completedToday: 1, remainingToday: 1 }),
            tier({ tierKey: '5', tierLabel: '5 题', points: 15, isActive: false }),
          ],
        },
        {
          taskCode: 'en_vocabulary',
          taskName: '英语背单词',
          tiers: [
            tier({ tierKey: '10', tierLabel: '10 词', points: 2, dailyLimit: 2, isActive: false }),
          ],
        },
      ],
    });

    const result = await controller.getMyRules(STUDENT);

    // 家长页要看到全部档位（含下架）才能重新启用，所以计数与分组仍走同一个 service 调用
    expect(rules.listGrouped).toHaveBeenCalledWith(7, { withDailyCounts: true });

    const targeted = result.tasks.find((task) => task.taskCode === 'math_targeted');
    expect(targeted?.tiers).toHaveLength(1);
    expect(targeted?.tiers.map((t) => t.tierKey)).toEqual(['3']);
    // 启用档位的展示字段原样透传（含今日计数），供配置页渲染「今日还剩 N 次」
    expect(targeted?.tiers[0]).toEqual({
      tierKey: '3',
      tierLabel: '3 题',
      points: 8,
      dailyLimit: 2,
      isActive: true,
      completedToday: 1,
      remainingToday: 1,
    });

    // 整组档位全下架 → 该组一个档位都不剩（学生端不出现「5 题」「10 词」）
    const vocab = result.tasks.find((task) => task.taskCode === 'en_vocabulary');
    expect(vocab?.tiers).toEqual([]);
    expect(result.tasks.flatMap((task) => task.tiers.map((t) => t.tierKey))).toEqual(['3']);
  });
});

describe('PointsController.getMyRewards', () => {
  it('原样透传 RedemptionService.listForStudent，学生 id 取自 JWT', async () => {
    const { controller, redemption } = makeController();
    const payload = {
      balance: 300,
      level: { code: 'pichai', name: '劈柴', index: 0, threshold: 0 },
      items: [
        {
          id: 1,
          name: '周末看电影',
          description: null,
          pointsCost: 200,
          minLevelCode: null,
          affordable: true,
          levelOk: true,
          gap: 0,
        },
      ],
    };
    redemption.listForStudent.mockResolvedValue(payload);

    await expect(controller.getMyRewards(STUDENT)).resolves.toBe(payload);
    expect(redemption.listForStudent).toHaveBeenCalledWith(7);
  });
});
