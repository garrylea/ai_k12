import { describe, it, expect, vi } from 'vitest';
import { SubscriptionsService } from './subscriptions.service';

const DAY = 86_400_000;

const mkDeps = () => ({
  subsRepo: {
    findByParentId: vi.fn().mockResolvedValue(null),
    findByStudentId: vi.fn().mockResolvedValue(null),
    upsertTrial: vi.fn().mockResolvedValue(undefined),
    renewWithinTx: vi.fn().mockResolvedValue({ currentPeriodEnd: new Date('2026-10-30T00:00:00.000Z') }),
  },
});

const mkSvc = (d: ReturnType<typeof mkDeps>) => new SubscriptionsService(d.subsRepo as any);

describe('SubscriptionsService.getStatusView', () => {
  it('学生视角：试用期内 -> trialing，daysRemaining=3，ISO 字符串序列化', async () => {
    const d = mkDeps();
    const trialEndsAt = new Date(Date.now() + 3 * DAY);
    d.subsRepo.findByStudentId.mockResolvedValue({
      trial_ends_at: trialEndsAt,
      current_period_end: null,
      plan_code: null,
    });
    const view = await mkSvc(d).getStatusView({ role: 'student', sub: 7 });
    expect(view).toEqual({
      status: 'trialing',
      planCode: null,
      trialEndsAt: trialEndsAt.toISOString(),
      currentPeriodEnd: null,
      daysRemaining: 3,
      source: 'trial',
    });
    expect(view.trialEndsAt).toBeTypeOf('string');
    expect(d.subsRepo.findByStudentId).toHaveBeenCalledWith(7);
    expect(d.subsRepo.findByParentId).not.toHaveBeenCalled();
  });

  it('家长视角走 findByParentId；付费期内 -> active + source=order + 按期剩余天数', async () => {
    const d = mkDeps();
    const currentPeriodEnd = new Date(Date.now() + 10 * DAY);
    d.subsRepo.findByParentId.mockResolvedValue({
      trial_ends_at: new Date(Date.now() - DAY),
      current_period_end: currentPeriodEnd,
      plan_code: 'month',
    });
    const view = await mkSvc(d).getStatusView({ role: 'parent', sub: 3 });
    expect(view.status).toBe('active');
    expect(view.source).toBe('order');
    expect(view.planCode).toBe('month');
    expect(view.daysRemaining).toBe(10);
    expect(view.currentPeriodEnd).toBe(currentPeriodEnd.toISOString());
    expect(d.subsRepo.findByParentId).toHaveBeenCalledWith(3);
    expect(d.subsRepo.findByStudentId).not.toHaveBeenCalled();
  });

  it('付费行（current_period_end 未来 + plan_code=month）-> {status:active, planCode:month}', async () => {
    const d = mkDeps();
    d.subsRepo.findByParentId.mockResolvedValue({
      trial_ends_at: null,
      current_period_end: new Date(Date.now() + 5 * DAY),
      plan_code: 'month',
    });
    const view = await mkSvc(d).getStatusView({ role: 'parent', sub: 3 });
    expect(view).toEqual({
      status: 'active',
      planCode: 'month',
      trialEndsAt: null,
      currentPeriodEnd: expect.any(String),
      daysRemaining: 5,
      source: 'order',
    });
  });

  it('admin 视角同样走 findByParentId', async () => {
    const d = mkDeps();
    const trialEndsAt = new Date(Date.now() + 5 * DAY);
    d.subsRepo.findByParentId.mockResolvedValue({
      trial_ends_at: trialEndsAt,
      current_period_end: null,
      plan_code: null,
    });
    const view = await mkSvc(d).getStatusView({ role: 'admin', sub: 1 });
    expect(view.status).toBe('trialing');
    expect(d.subsRepo.findByParentId).toHaveBeenCalledWith(1);
  });

  it('无订阅行 -> expired 空视图（null 字段 + daysRemaining=0）', async () => {
    const d = mkDeps();
    const view = await mkSvc(d).getStatusView({ role: 'parent', sub: 3 });
    expect(view).toEqual({
      status: 'expired',
      planCode: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
      daysRemaining: 0,
      source: 'trial',
    });
  });

  it('试用已过期且无付费期 -> expired，daysRemaining=0', async () => {
    const d = mkDeps();
    d.subsRepo.findByStudentId.mockResolvedValue({
      trial_ends_at: new Date(Date.now() - 2 * DAY),
      current_period_end: null,
      plan_code: null,
    });
    const view = await mkSvc(d).getStatusView({ role: 'student', sub: 7 });
    expect(view.status).toBe('expired');
    expect(view.daysRemaining).toBe(0);
  });
});

describe('SubscriptionsService.ensureTrial', () => {
  it('调用 upsertTrial(parentId, now+7d)，允许 ±1 分钟误差', async () => {
    const d = mkDeps();
    await mkSvc(d).ensureTrial(9);
    expect(d.subsRepo.upsertTrial).toHaveBeenCalledTimes(1);
    const [parentId, trialEndsAt] = d.subsRepo.upsertTrial.mock.calls[0];
    expect(parentId).toBe(9);
    const expected = Date.now() + 7 * DAY;
    expect(Math.abs((trialEndsAt as Date).getTime() - expected)).toBeLessThan(60_000);
  });

  it('upsertTrial 抛错时向外传播（注册必须可见地失败）', async () => {
    const d = mkDeps();
    d.subsRepo.upsertTrial.mockRejectedValue(new Error('db down'));
    await expect(mkSvc(d).ensureTrial(9)).rejects.toThrow('db down');
  });
});

describe('SubscriptionsService.renewWithinTx', () => {
  it('透传 repo：conn/parentId/planCode/durationDays 原样，now 由 service 注入', async () => {
    const d = mkDeps();
    const conn = {} as any;
    const result = await mkSvc(d).renewWithinTx(conn, 3, 'year', 365);
    expect(d.subsRepo.renewWithinTx).toHaveBeenCalledWith(conn, 3, 'year', 365, expect.any(Date));
    expect(result).toEqual({ currentPeriodEnd: new Date('2026-10-30T00:00:00.000Z') });
  });
});
