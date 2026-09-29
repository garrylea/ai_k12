import { describe, it, expect, vi, afterEach } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { SubscriptionGuard, SUBSCRIPTION_EXEMPT } from './subscription.guard.js';
import type { FamilySubscriptionTimes } from '../../database/repositories/family-subscriptions.repo.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** 构造最小 ExecutionContext：switchToHttp().getRequest() 返回给定 req。 */
function makeCtx(req: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

/** mock 仓储：findByStudentId 可配置返回行，并记录调用次数。 */
function makeRepo(row: FamilySubscriptionTimes | null) {
  return {
    findByStudentId: vi.fn(async (): Promise<FamilySubscriptionTimes | null> => row),
  };
}

const TRIALING: FamilySubscriptionTimes = {
  trial_ends_at: new Date(Date.now() + 7 * 86_400_000),
  current_period_end: null,
  plan_code: null,
};

const EXPIRED: FamilySubscriptionTimes = {
  trial_ends_at: new Date(Date.now() - 86_400_000),
  current_period_end: null,
  plan_code: null,
};

describe('SubscriptionGuard', () => {
  it('试用期内学生放行，且查了一次 repo', async () => {
    const repo = makeRepo(TRIALING);
    const guard = new SubscriptionGuard(repo as never);
    const ctx = makeCtx({
      method: 'GET',
      originalUrl: '/api/points/me',
      user: { sub: 1, role: 'student' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(repo.findByStudentId).toHaveBeenCalledTimes(1);
  });

  it('订阅过期的学生 -> ForbiddenException 且 code === 2001', async () => {
    const repo = makeRepo(EXPIRED);
    const guard = new SubscriptionGuard(repo as never);
    const ctx = makeCtx({
      method: 'GET',
      originalUrl: '/api/points/me',
      user: { sub: 1, role: 'student' },
    });
    const err = await guard.canActivate(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse().code).toBe(2001);
  });

  it('无订阅行（null）视为 expired -> 403', async () => {
    const repo = makeRepo(null);
    const guard = new SubscriptionGuard(repo as never);
    const ctx = makeCtx({
      method: 'GET',
      originalUrl: '/api/points/me',
      user: { sub: 1, role: 'student' },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('无 user（免 JWT 链路）放行且不查 repo', async () => {
    const repo = makeRepo(EXPIRED);
    const guard = new SubscriptionGuard(repo as never);
    const ctx = makeCtx({ method: 'POST', originalUrl: '/api/billing/callback/x' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(repo.findByStudentId).not.toHaveBeenCalled();
  });

  it('家长角色放行且不查 repo（家长必须能进订阅中心）', async () => {
    const repo = makeRepo(EXPIRED);
    const guard = new SubscriptionGuard(repo as never);
    const ctx = makeCtx({
      method: 'GET',
      originalUrl: '/api/parent/billing/subscription',
      user: { sub: 9, role: 'parent' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(repo.findByStudentId).not.toHaveBeenCalled();
  });

  it('豁免：星图 GET 放行且不查 repo；同路径 POST 不豁免（仍查 repo）', async () => {
    const repo = makeRepo(EXPIRED);
    const guard = new SubscriptionGuard(repo as never);
    const url = '/api/progress/students/42/star-map';
    const getCtx = makeCtx({ method: 'GET', originalUrl: url, user: { sub: 42, role: 'student' } });
    await expect(guard.canActivate(getCtx)).resolves.toBe(true);
    expect(repo.findByStudentId).not.toHaveBeenCalled();

    const postCtx = makeCtx({
      method: 'POST',
      originalUrl: url,
      user: { sub: 42, role: 'student' },
    });
    await expect(guard.canActivate(postCtx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.findByStudentId).toHaveBeenCalledTimes(1);
  });

  it('豁免路径带 query string 仍命中（originalUrl 去 ? 后匹配）', async () => {
    const repo = makeRepo(EXPIRED);
    const guard = new SubscriptionGuard(repo as never);
    const ctx = makeCtx({
      method: 'GET',
      originalUrl: '/api/quota/subscription?foo=1',
      user: { sub: 1, role: 'student' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(repo.findByStudentId).not.toHaveBeenCalled();
  });

  it('非豁免的相近路径不被误豁免（前缀相似但多一段）', async () => {
    const repo = makeRepo(EXPIRED);
    const guard = new SubscriptionGuard(repo as never);
    const ctx = makeCtx({
      method: 'GET',
      originalUrl: '/api/progress/students/42/star-map/extra',
      user: { sub: 42, role: 'student' },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('SUBSCRIPTION_EXEMPT 护栏', () => {
  it('每一项 method ∈ {GET, POST}', () => {
    for (const e of SUBSCRIPTION_EXEMPT) {
      expect(['GET', 'POST']).toContain(e.method);
    }
  });

  it('每一项 pattern 以 ^/api/ 开头且以 $ 结尾（防宽松前缀匹配豁免面失控）', () => {
    for (const e of SUBSCRIPTION_EXEMPT) {
      expect(e.pattern.source.startsWith('^\\/api\\/')).toBe(true);
      expect(e.pattern.source.endsWith('$')).toBe(true);
    }
  });
});
