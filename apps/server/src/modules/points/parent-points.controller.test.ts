import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ParentPointsController } from './parent-points.controller.js';
import type { ParentService } from '../parent/parent.service.js';
import type { PointsService } from './points.service.js';
import type { PointRulesService } from './point-rules.service.js';
import type { RedemptionService } from './redemption.service.js';
import type { ControlsRepository, ControlsSnapshot } from '../../database/repositories/controls.repo.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';

/**
 * Nest 的 `GUARDS_METADATA` 常量值（`@nestjs/common` 未从包入口导出，同
 * `points.controller.test.ts` 的用法）。用字面量 + 用例钉住，防装饰器被误删。
 */
const GUARDS_METADATA = '__guards__';

const PARENT: JwtUser = { sub: 9, role: 'parent' };
const STUDENT: JwtUser = { sub: 7, role: 'student' };

/** 属于本家长（sub=9）的孩子。 */
const OWNED_STUDENT = { id: 7, parentId: 9 };

const VALID_RULE = {
  taskCode: 'math_targeted',
  tierKey: '3',
  points: 8,
  dailyLimit: 2,
  isActive: true,
};

const VALID_CATALOG_ITEM = {
  id: 5,
  name: '周末看电影',
  description: null,
  pointsCost: 200,
  minLevelCode: null,
  isActive: true,
  sortOrder: 0,
};

const SETTINGS: ControlsSnapshot = {
  pointsPerYuan: 20,
  rewardRedemptionEnabled: true,
  alertAwayMinutes: 5,
  alertIdleMinutes: 15,
  sessionLockMinutes: null,
};

type MockFn = ReturnType<typeof vi.fn>;

/** 造一个只够 `JwtAuthGuard` / `RolesGuard` 用的 `ExecutionContext`。 */
function mkCtx(user: unknown, handler: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => ParentPointsController,
  } as unknown as ExecutionContext;
}

/** 造一个 controller：五个依赖全是 mock，不连库、不解析 DI。 */
function makeController(over: {
  parent?: { requireOwnedStudent?: MockFn };
  points?: { getOverview?: MockFn; getLedger?: MockFn };
  rules?: { listGrouped?: MockFn; updateBatch?: MockFn };
  redemption?: {
    listCatalog?: MockFn;
    saveCatalog?: MockFn;
    redeem?: MockFn;
    listRedemptions?: MockFn;
    setRedemptionStatus?: MockFn;
    findStudentIdByRedemptionId?: MockFn;
  };
  controls?: { ensure?: MockFn; findByStudent?: MockFn; update?: MockFn };
} = {}) {
  const parent = {
    requireOwnedStudent: vi.fn().mockResolvedValue(OWNED_STUDENT),
    ...over.parent,
  };
  const points = { getOverview: vi.fn(), getLedger: vi.fn(), ...over.points };
  const rules = { listGrouped: vi.fn(), updateBatch: vi.fn(), ...over.rules };
  const redemption = {
    listCatalog: vi.fn(),
    saveCatalog: vi.fn(),
    redeem: vi.fn(),
    listRedemptions: vi.fn(),
    setRedemptionStatus: vi.fn(),
    findStudentIdByRedemptionId: vi.fn().mockResolvedValue(OWNED_STUDENT.id),
    ...over.redemption,
  };
  const controls = {
    ensure: vi.fn(),
    findByStudent: vi.fn().mockResolvedValue(SETTINGS),
    update: vi.fn(),
    ...over.controls,
  };
  const controller = new ParentPointsController(
    parent as unknown as ParentService,
    points as unknown as PointsService,
    rules as unknown as PointRulesService,
    redemption as unknown as RedemptionService,
    controls as unknown as ControlsRepository,
  );
  return { controller, parent, points, rules, redemption, controls };
}

/** 取 promise 抛出的 HTTP 异常（没抛则用例失败），便于断言响应体里的业务码。 */
async function captureHttpError(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpException) return err;
    throw err;
  }
  throw new Error('预期抛出 HttpException，但调用成功了');
}

/** 模拟 `ParentService.requireOwnedStudent` 的「别人家的孩子」分支。 */
function foreignChild() {
  return new ForbiddenException({ code: 1005, message: '无权操作该学生' });
}

/**
 * 每个端点的最小可调用形式。归属校验用例与守卫用例都靠它做数据驱动——
 * 新增端点若忘了挂守卫或忘了 `requireOwnedStudent`，这里会红。
 */
const ENDPOINTS: Array<[string, unknown, (c: ParentPointsController, u: JwtUser) => Promise<unknown>]> = [
  ['GET students/:id/points', ParentPointsController.prototype.getPoints, (c, u) => c.getPoints(u, 7)],
  ['GET students/:id/points/rules', ParentPointsController.prototype.getRules, (c, u) => c.getRules(u, 7)],
  [
    'PUT students/:id/points/rules',
    ParentPointsController.prototype.saveRules,
    (c, u) => c.saveRules(u, 7, { rules: [VALID_RULE] }),
  ],
  ['GET students/:id/points/ledger', ParentPointsController.prototype.getLedger, (c, u) => c.getLedger(u, 7)],
  [
    'GET students/:id/reward-catalog',
    ParentPointsController.prototype.getCatalog,
    (c, u) => c.getCatalog(u, 7),
  ],
  [
    'PUT students/:id/reward-catalog',
    ParentPointsController.prototype.saveCatalog,
    (c, u) => c.saveCatalog(u, 7, { items: [VALID_CATALOG_ITEM] }),
  ],
  [
    'POST students/:id/points/redeem',
    ParentPointsController.prototype.redeem,
    (c, u) => c.redeem(u, 7, { type: 'cash', points: 100 }),
  ],
  [
    'GET students/:id/redemptions',
    ParentPointsController.prototype.getRedemptions,
    (c, u) => c.getRedemptions(u, 7),
  ],
  [
    'PATCH redemptions/:id',
    ParentPointsController.prototype.patchRedemption,
    (c, u) => c.patchRedemption(u, 55, { status: 'fulfilled' }),
  ],
  [
    'GET students/:id/points/settings',
    ParentPointsController.prototype.getSettings,
    (c, u) => c.getSettings(u, 7),
  ],
  [
    'PUT students/:id/points/settings',
    ParentPointsController.prototype.saveSettings,
    (c, u) => c.saveSettings(u, 7, { rewardRedemptionEnabled: false }),
  ],
];

describe('ParentPointsController 守卫', () => {
  const jwtGuard = new JwtAuthGuard();
  const rolesGuard = new RolesGuard(new Reflector());

  // 按 Nest 的注册顺序依次跑：先 JwtAuthGuard（无 token → 401），再 RolesGuard（角色不符 → 403）
  const run = (user: unknown, handler: unknown) => {
    const context = mkCtx(user, handler);
    jwtGuard.canActivate(context);
    rolesGuard.canActivate(context);
  };

  it('类上挂了 JwtAuthGuard + RolesGuard 并标了 @Roles("parent")', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ParentPointsController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));

    // 学生 token 在每个端点上都被拒（@Roles 挂在类上，对全部 handler 生效）
    for (const [, handler] of ENDPOINTS) {
      expect(() => run(STUDENT, handler)).toThrow(ForbiddenException);
    }
  });

  it('每个端点：无 token → 401，家长 token → 放行', () => {
    for (const [, handler] of ENDPOINTS) {
      expect(() => run(undefined, handler)).toThrow(UnauthorizedException);
      expect(() => run(PARENT, handler)).not.toThrow();
    }
  });
});

describe('ParentPointsController 归属校验', () => {
  it('每个端点的第一件事都是 requireOwnedStudent(parentId, studentId)；别人家孩子 → 403 1005', async () => {
    for (const [name, , invoke] of ENDPOINTS) {
      const made = makeController({
        parent: { requireOwnedStudent: vi.fn().mockRejectedValue(foreignChild()) },
      });
      const { controller, parent } = made;

      const err = await captureHttpError(invoke(controller, PARENT));

      expect(err, name).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse(), name).toMatchObject({ code: 1005 });
      // PATCH 的 studentId 来自兑换单反查，其余端点直接取路径 id
      expect(parent.requireOwnedStudent, name).toHaveBeenCalledWith(
        PARENT.sub,
        name.startsWith('PATCH') ? OWNED_STUDENT.id : 7,
      );

      // 归属校验必须是**真正的第一道门**：403 之后一个下游都不许碰（防「先查数据再判归属」回归）
      const downstream: MockFn[] = [
        made.points.getOverview,
        made.points.getLedger,
        made.rules.listGrouped,
        made.rules.updateBatch,
        made.redemption.listCatalog,
        made.redemption.saveCatalog,
        made.redemption.redeem,
        made.redemption.listRedemptions,
        made.redemption.setRedemptionStatus,
        made.controls.ensure,
        made.controls.findByStudent,
        made.controls.update,
      ];
      for (const mock of downstream) {
        expect(mock, `${name} 在归属校验失败后仍调用了下游`).not.toHaveBeenCalled();
      }
    }
  });

  it('PATCH redemptions/:id：先按 id 反查兑换单拿 student_id，再跑归属校验', async () => {
    const { controller, parent, redemption } = makeController();

    await controller.patchRedemption(PARENT, 55, { status: 'fulfilled' });

    expect(redemption.findStudentIdByRedemptionId).toHaveBeenCalledWith(55);
    expect(parent.requireOwnedStudent).toHaveBeenCalledWith(PARENT.sub, OWNED_STUDENT.id);
  });

  it('PATCH redemptions/:id：兑换单不存在 → 404 1002，且不做归属校验、不写状态', async () => {
    const { controller, parent, redemption } = makeController({
      redemption: {
        findStudentIdByRedemptionId: vi
          .fn()
          .mockRejectedValue(new NotFoundException({ code: 1002, message: '兑换单不存在' })),
      },
    });

    const err = await captureHttpError(controller.patchRedemption(PARENT, 999, { status: 'fulfilled' }));

    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.getResponse()).toMatchObject({ code: 1002 });
    expect(parent.requireOwnedStudent).not.toHaveBeenCalled();
    expect(redemption.setRedemptionStatus).not.toHaveBeenCalled();
  });

  it('PATCH redemptions/:id：兑换单属于别人家孩子 → 403 1005，不写状态', async () => {
    const { controller, redemption } = makeController({
      parent: { requireOwnedStudent: vi.fn().mockRejectedValue(foreignChild()) },
    });

    const err = await captureHttpError(controller.patchRedemption(PARENT, 55, { status: 'fulfilled' }));

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code: 1005 });
    expect(redemption.setRedemptionStatus).not.toHaveBeenCalled();
  });
});

describe('ParentPointsController 入参校验（Zod → 400，绝不 500）', () => {
  it('PUT rules：points < 0 / points > 9999 / dailyLimit = 0 一律 400', async () => {
    const bad = [
      { ...VALID_RULE, points: -1 },
      { ...VALID_RULE, points: 10000 },
      { ...VALID_RULE, dailyLimit: 0 },
    ];
    for (const rule of bad) {
      const { controller, rules } = makeController();
      const err = await captureHttpError(controller.saveRules(PARENT, 7, { rules: [rule] }));
      expect(err, JSON.stringify(rule)).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ code: 1001 });
      expect(rules.updateBatch).not.toHaveBeenCalled();
    }
  });

  it('PUT rules：空数组 / 缺 rules 字段 → 400', async () => {
    for (const body of [{ rules: [] }, {}]) {
      const { controller } = makeController();
      const err = await captureHttpError(controller.saveRules(PARENT, 7, body));
      expect(err).toBeInstanceOf(BadRequestException);
    }
  });

  it('PUT reward-catalog：条目缺 isActive → 400（不能靠缺省等于重新上架）', async () => {
    const { id: _id, isActive: _isActive, ...withoutIsActive } = VALID_CATALOG_ITEM;
    const { controller, redemption } = makeController();

    const err = await captureHttpError(controller.saveCatalog(PARENT, 7, { items: [withoutIsActive] }));

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 1001 });
    expect(redemption.saveCatalog).not.toHaveBeenCalled();
  });

  it('PUT points/settings：空对象 → 400（至少要改一项）', async () => {
    const { controller, controls } = makeController();

    const err = await captureHttpError(controller.saveSettings(PARENT, 7, {}));

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 1001 });
    expect(controls.update).not.toHaveBeenCalled();
  });

  it('PUT points/settings：pointsPerYuan 越界（0 / 10000）→ 400', async () => {
    for (const body of [{ pointsPerYuan: 0 }, { pointsPerYuan: 10000 }]) {
      const { controller } = makeController();
      const err = await captureHttpError(controller.saveSettings(PARENT, 7, body));
      expect(err).toBeInstanceOf(BadRequestException);
    }
  });

  it('POST redeem：discriminated union —— {type:"cash"} 缺 points → 400', async () => {
    const { controller, redemption } = makeController();

    const err = await captureHttpError(controller.redeem(PARENT, 7, { type: 'cash' }));

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 1001 });
    expect(redemption.redeem).not.toHaveBeenCalled();
  });

  it('POST redeem：{type:"reward"} 缺 catalogId / type 非法 → 400', async () => {
    for (const body of [{ type: 'reward' }, { type: 'points', points: 1 }]) {
      const { controller } = makeController();
      const err = await captureHttpError(controller.redeem(PARENT, 7, body));
      expect(err).toBeInstanceOf(BadRequestException);
    }
  });

  it('PATCH redemptions/:id：status 非 pending/fulfilled → 400', async () => {
    const { controller, redemption } = makeController();

    const err = await captureHttpError(controller.patchRedemption(PARENT, 55, { status: 'done' }));

    expect(err).toBeInstanceOf(BadRequestException);
    expect(redemption.setRedemptionStatus).not.toHaveBeenCalled();
  });
});

describe('ParentPointsController 分页', () => {
  it('GET ledger：默认 page=1 / pageSize=20，合法值原样透传', async () => {
    const { controller, points } = makeController();
    points.getLedger.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await controller.getLedger(PARENT, 7);
    expect(points.getLedger).toHaveBeenLastCalledWith(7, 1, 20);

    await controller.getLedger(PARENT, 7, '2', '100');
    expect(points.getLedger).toHaveBeenLastCalledWith(7, 2, 100);
  });

  it('GET ledger：越界/非法 page/pageSize → 400，不静默钳制', async () => {
    const bad: Array<[string, string]> = [
      ['0', '20'],
      ['-1', '20'],
      ['1', '0'],
      ['1', '101'],
      ['1', '20.5'],
      ['abc', '20'],
    ];
    for (const [page, pageSize] of bad) {
      const { controller, points } = makeController();
      const err = await captureHttpError(controller.getLedger(PARENT, 7, page, pageSize));
      expect(err, `${page}/${pageSize}`).toBeInstanceOf(BadRequestException);
      expect(points.getLedger).not.toHaveBeenCalled();
    }
  });

  it('GET redemptions：page 默认 1，非法 page → 400', async () => {
    const { controller, redemption } = makeController();
    redemption.listRedemptions.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await controller.getRedemptions(PARENT, 7);
    expect(redemption.listRedemptions).toHaveBeenLastCalledWith(7, 1);

    const err = await captureHttpError(controller.getRedemptions(PARENT, 7, '0'));
    expect(err).toBeInstanceOf(BadRequestException);
  });
});

describe('ParentPointsController 端点透传', () => {
  it('GET students/:id/points → PointsService.getOverview(studentId)', async () => {
    const { controller, points } = makeController();
    const overview = { balance: 300, totalEarned: 1200 };
    points.getOverview.mockResolvedValue(overview);

    await expect(controller.getPoints(PARENT, 7)).resolves.toBe(overview);
    expect(points.getOverview).toHaveBeenCalledWith(7);
  });

  it('GET students/:id/points/rules → 家长视角拿全部档位（含下架），withDailyCounts: true', async () => {
    const { controller, rules } = makeController();
    const grouped = { tasks: [{ taskCode: 'math_targeted', taskName: '数学专项', tiers: [] }] };
    rules.listGrouped.mockResolvedValue(grouped);

    await expect(controller.getRules(PARENT, 7)).resolves.toBe(grouped);
    expect(rules.listGrouped).toHaveBeenCalledWith(7, { withDailyCounts: true });
  });

  it('PUT students/:id/points/rules → 逐条原样交给 updateBatch（不做第二套加工）', async () => {
    const { controller, rules } = makeController();

    await expect(controller.saveRules(PARENT, 7, { rules: [VALID_RULE] })).resolves.toBeNull();
    expect(rules.updateBatch).toHaveBeenCalledWith(7, [VALID_RULE]);
  });

  it('GET students/:id/reward-catalog → listCatalog（含软删行，家长要能重新上架）', async () => {
    const { controller, redemption } = makeController();
    const rows = [{ id: 5, name: '周末看电影', isActive: false }];
    redemption.listCatalog.mockResolvedValue(rows);

    await expect(controller.getCatalog(PARENT, 7)).resolves.toBe(rows);
    expect(redemption.listCatalog).toHaveBeenCalledWith(7);
  });

  it('PUT students/:id/reward-catalog → saveCatalog，返回保存后的完整清单', async () => {
    const { controller, redemption } = makeController();
    const saved = [{ id: 5, name: '周末看电影', isActive: true }];
    redemption.saveCatalog.mockResolvedValue(saved);

    await expect(controller.saveCatalog(PARENT, 7, { items: [VALID_CATALOG_ITEM] })).resolves.toBe(saved);
    expect(redemption.saveCatalog).toHaveBeenCalledWith(7, [VALID_CATALOG_ITEM]);
  });

  it('POST students/:id/points/redeem → 两条分支分别透传', async () => {
    const { controller, redemption } = makeController();
    const result = { redemption: { id: 55 }, balance: 200 };
    redemption.redeem.mockResolvedValue(result);

    await expect(controller.redeem(PARENT, 7, { type: 'cash', points: 100 })).resolves.toBe(result);
    expect(redemption.redeem).toHaveBeenLastCalledWith(7, { type: 'cash', points: 100 });

    await controller.redeem(PARENT, 7, { type: 'reward', catalogId: 5 });
    expect(redemption.redeem).toHaveBeenLastCalledWith(7, { type: 'reward', catalogId: 5 });
  });

  it('GET students/:id/redemptions → listRedemptions(studentId, page)', async () => {
    const { controller, redemption } = makeController();
    const list = { items: [], total: 0, page: 3, pageSize: 20 };
    redemption.listRedemptions.mockResolvedValue(list);

    await expect(controller.getRedemptions(PARENT, 7, '3')).resolves.toBe(list);
    expect(redemption.listRedemptions).toHaveBeenCalledWith(7, 3);
  });

  it('PATCH redemptions/:id → setRedemptionStatus(归属学生, id, status)', async () => {
    const { controller, redemption } = makeController();

    await expect(controller.patchRedemption(PARENT, 55, { status: 'pending' })).resolves.toBeNull();
    expect(redemption.setRedemptionStatus).toHaveBeenCalledWith(OWNED_STUDENT.id, 55, 'pending');
  });

  it('GET/PUT students/:id/points/settings 读写 controls（ensure 先行）', async () => {
    const { controller, controls } = makeController();

    // 响应只含兑换两字段：`findByStudent` 回的是五字段快照（SETTINGS），而 `toEqual` 精确相等，
    // 因此这条断言顺带钉住 `alertAwayMinutes` / `alertIdleMinutes` / `sessionLockMinutes`
    // 不被积分端点泄漏出去。
    await expect(controller.getSettings(PARENT, 7)).resolves.toEqual({
      pointsPerYuan: SETTINGS.pointsPerYuan,
      rewardRedemptionEnabled: SETTINGS.rewardRedemptionEnabled,
    });
    expect(controls.ensure).toHaveBeenCalledWith(7);
    expect(controls.findByStudent).toHaveBeenCalledWith(7);

    controls.findByStudent.mockResolvedValue({ pointsPerYuan: 50, rewardRedemptionEnabled: false });
    const updated = await controller.saveSettings(PARENT, 7, { pointsPerYuan: 50 });
    expect(controls.update).toHaveBeenCalledWith(7, { pointsPerYuan: 50 });
    expect(updated).toEqual({ pointsPerYuan: 50, rewardRedemptionEnabled: false });
  });
});
