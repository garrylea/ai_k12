import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminController } from './admin.controller.js';
import type { AdminModelsService } from './admin-models.service.js';
import type { AdminAccountsService } from './admin-accounts.service.js';
import type { AdminMessagesService } from './admin-messages.service.js';
import type { AdminNotificationsService } from './admin-notifications.service.js';
import type { AdminChatService } from './admin-chat.service.js';
import type { AdminDashboardService } from './admin-dashboard.service.js';
import type { AdminAlertsService } from './admin-alerts.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';

/**
 * Nest 的元数据常量值。`@nestjs/common` 没从包入口导出这些字符串
 * （内部在 `@nestjs/common/constants`），这里用字面量 + 用例钉住，防装饰器被误删。
 * 同款写法见 `points.controller.test.ts:21`。
 */
const GUARDS_METADATA = '__guards__';
const METHOD_METADATA = 'method';
const PATH_METADATA = 'path';

/** vitest mock 函数类型；用 `ReturnType` 取，省得手写泛型。 */
type MockFn = ReturnType<typeof vi.fn>;

/** 七个 service 全 mock，不连库；本文件只关心新增的两个预警端点。 */
function makeController(over: { preview?: MockFn; purge?: MockFn } = {}) {
  const alerts = {
    preview: vi.fn().mockResolvedValue({ retentionDays: 30, cutoff: 'x', total: 0, unread: 0 }),
    purge: vi.fn().mockResolvedValue({ retentionDays: 30, cutoff: 'x', deleted: 0 }),
    ...over,
  };
  const stub = () => vi.fn();
  const controller = new AdminController(
    stub() as unknown as AdminModelsService,
    stub() as unknown as AdminAccountsService,
    stub() as unknown as AdminMessagesService,
    stub() as unknown as AdminNotificationsService,
    stub() as unknown as AdminChatService,
    stub() as unknown as AdminDashboardService,
    alerts as unknown as AdminAlertsService,
  );
  return { controller, alerts };
}

describe('AdminController 预警端点：路由形状', () => {
  it('两个端点同挂 /alerts/expired，方法分别是 GET / DELETE', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminController.prototype.expiredAlerts)).toBe(
      'alerts/expired',
    );
    expect(Reflect.getMetadata(PATH_METADATA, AdminController.prototype.purgeExpiredAlerts)).toBe(
      'alerts/expired',
    );

    // ⚠️ 这条是「清理用 @Delete（200）而不是 @Post（201）」的钉子：
    // 本仓无端点用 @HttpCode 覆盖，所以方法装饰器就是状态码的唯一来源。
    expect(Reflect.getMetadata(METHOD_METADATA, AdminController.prototype.expiredAlerts)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(METHOD_METADATA, AdminController.prototype.purgeExpiredAlerts)).toBe(
      RequestMethod.DELETE,
    );
  });

  it('类上仍挂 JwtAuthGuard + RolesGuard（新增端点不得绕过鉴权）', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));
  });

  it('类上仍标 @Roles("admin")，且 Reflector 能读到（RolesGuard 据此放行）', () => {
    const roles = new Reflector().get<string[]>('roles', AdminController);
    expect(roles).toEqual(['admin']);
  });
});

describe('AdminController 预警端点：委派', () => {
  it('GET 委派给 preview()，原样返回（无入参、不做二次加工）', async () => {
    const payload = { retentionDays: 30, cutoff: '2026-08-21T10:00:00.000Z', total: 12, unread: 3 };
    const { controller, alerts } = makeController({ preview: vi.fn().mockResolvedValue(payload) });

    await expect(controller.expiredAlerts()).resolves.toBe(payload);
    expect(alerts.preview).toHaveBeenCalledTimes(1);
    // 预览不得顺手删
    expect(alerts.purge).not.toHaveBeenCalled();
  });

  it('DELETE 委派给 purge()，返回 deleted（不是 preview 的 total）', async () => {
    const payload = { retentionDays: 30, cutoff: '2026-08-21T10:00:00.000Z', deleted: 12 };
    const { controller, alerts } = makeController({ purge: vi.fn().mockResolvedValue(payload) });

    await expect(controller.purgeExpiredAlerts()).resolves.toBe(payload);
    expect(alerts.purge).toHaveBeenCalledTimes(1);
    expect(alerts.preview).not.toHaveBeenCalled();
  });
});
