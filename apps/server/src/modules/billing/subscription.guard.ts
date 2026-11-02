import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { FamilySubscriptionsRepository } from '../../database/repositories/family-subscriptions.repo.js';
import { effectiveStatus } from './subscription-status.js';

/**
 * 豁免清单（spec §4 钉死）：学生端在锁定态仍需可用的端点。
 * 护栏测试（subscription.guard.test.ts）扫这份清单——新增学生端点默认被锁，
 * 要豁免必须显式加这里并同步改护栏。
 *
 * ⚠️ **锁定页自身会调的端点必须在这里**（2026-11-02 修）：前端 `api.ts` 收到 2001
 * 会对 `/student/locked` 再 assign 一次，而 assign 同一个 URL 也是**整页重载**。
 * 于是「锁定页发出的请求 → 2001 → 重载 → 又发 → 又 2001」会无限循环
 * （PC App 实测 10 秒 389 次主 frame 导航），锁定页两个标题来回闪。
 * 判据不是「跟学习有没有关系」，而是**这一页会不会自己发**。
 */
export const SUBSCRIPTION_EXEMPT: { method: string; pattern: RegExp }[] = [
  { method: 'GET', pattern: /^\/api\/progress\/students\/\d+\/star-map$/ }, // 锁后学生仍看星图与锁定态
  { method: 'GET', pattern: /^\/api\/quota\/subscription$/ },               // 锁定页读状态
  // PC App 壳（kiosk）端点的三条：只搬运管控状态，不含学习内容。
  // 缺任一条 → 锁定页无限重载（见上方 ⚠️）：轮询每 10s、建会话在挂载即发、登出走 end。
  { method: 'GET', pattern: /^\/api\/student\/device-commands$/ },          // 10s 轮询（兼心跳）
  { method: 'POST', pattern: /^\/api\/student\/learning-sessions$/ },       // 无本地会话时「取或建」
  { method: 'PATCH', pattern: /^\/api\/student\/learning-sessions\/\d+\/end$/ }, // 登出收尾
];

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private subsRepo: FamilySubscriptionsRepository) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as { sub: number; role: string } | undefined;
    // 无用户（免 JWT 链路，如渠道回调）或非学生角色一律放行——家长必须能进订阅中心
    if (!user || user.role !== 'student') return true;
    const path = req.originalUrl.split('?')[0];
    if (SUBSCRIPTION_EXEMPT.some((e) => e.method === req.method && e.pattern.test(path)))
      return true;
    const row = await this.subsRepo.findByStudentId(user.sub);
    const status = effectiveStatus(new Date(), {
      trialEndsAt: row?.trial_ends_at ?? null,
      currentPeriodEnd: row?.current_period_end ?? null,
    });
    if (status === 'expired') {
      throw new ForbiddenException({ code: 2001, message: '订阅已过期，请联系家长续费' });
    }
    return true;
  }
}
