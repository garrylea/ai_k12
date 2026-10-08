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
 */
export const SUBSCRIPTION_EXEMPT: { method: string; pattern: RegExp }[] = [
  { method: 'GET', pattern: /^\/api\/progress\/students\/\d+\/star-map$/ }, // 锁后学生仍看星图与锁定态
  { method: 'GET', pattern: /^\/api\/quota\/subscription$/ },               // 锁定页读状态
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
